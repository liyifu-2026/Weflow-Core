/**
 * npm-style Solution Store.
 *
 * Manages a versioned, immutable Solution install directory plus an `active`
 * junction that can be atomically switched for upgrade/rollback.
 *
 * Layout:
 *   <root>/<solution-id>/<version>/...
 *   <root>/<solution-id>/active -> <version>
 *   <root>/weflow-solution.lock.json
 */
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { gt as semverGt, valid as semverValid } from "semver";
import { stagePackagedSolution } from "./solution-stage.js";

export type SolutionLockEntry = {
  solutionId: string;
  version: string;
  manifestDigest: string;
  installedAt: string;
};

export type SolutionActivationEntry = {
  solutionId: string;
  version: string;
  activatedAt: string;
};

export type SolutionLockfile = {
  schemaVersion: 1;
  solutions: SolutionLockEntry[];
  /** Append-only activation log; newest last. Used for rollback decisions. */
  activations?: SolutionActivationEntry[];
};

export function getSolutionStoreRoot(): string {
  return resolve(
    process.env.WEFLOW_SOLUTION_STORE ??
      join(homedir(), ".weflow", "solutions"),
  );
}

export async function ensureSolutionStore(): Promise<string> {
  const root = getSolutionStoreRoot();
  await mkdir(root, { recursive: true });
  return root;
}

export async function installSolutionToStore(
  sourceDir: string,
  solutionId: string,
  version: string,
  manifestDigest: string,
): Promise<string> {
  const root = await ensureSolutionStore();
  const dest = join(root, solutionId, version);
  await rm(dest, { recursive: true, force: true });
  await mkdir(join(root, solutionId), { recursive: true });
  // A directory carrying lock+signature is an already-staged package: copy
  // verbatim. Anything else is a source tree that must be bundled first so
  // the stored copy never depends on the original workspace's node_modules.
  const staged =
    existsSync(join(sourceDir, "solution.lock.json")) &&
    existsSync(join(sourceDir, "signature.json"))
      ? null
      : await stagePackagedSolution(sourceDir);
  const copySource = staged ?? sourceDir;
  try {
    await cp(resolve(copySource), dest, { recursive: true });
  } finally {
    if (staged) await rm(staged, { recursive: true, force: true });
  }
  await appendLockEntry({
    solutionId,
    version,
    manifestDigest,
    installedAt: new Date().toISOString(),
  });
  return dest;
}

export async function activateSolution(
  solutionId: string,
  version: string,
): Promise<string> {
  const root = await ensureSolutionStore();
  const versionDir = join(root, solutionId, version);
  if (!existsSync(versionDir)) {
    throw new Error(`solution_version_not_in_store:${solutionId}:${version}`);
  }
  const activePath = join(root, solutionId, "active");
  await rm(activePath, { recursive: true, force: true });
  // Directory junction works without admin privileges on Windows and behaves
  // like a symlink for our read/import use cases.
  await symlink(versionDir, activePath, "junction");
  const lock = await readSolutionLockfile();
  lock.activations = [
    ...(lock.activations ?? []).filter(
      (item) => !(item.solutionId === solutionId && item.version === version),
    ),
    { solutionId, version, activatedAt: new Date().toISOString() },
  ];
  await writeSolutionLockfile(lock);
  return activePath;
}

/** Resolve the currently active version of a solution, or null. */
export async function readActiveVersion(
  solutionId: string,
): Promise<string | null> {
  const activeDir = await resolveActiveSolutionDir(solutionId);
  if (!activeDir) return null;
  return basename(activeDir);
}

/** List installed versions for a solution in ascending semver order. */
export async function listInstalledVersions(
  solutionId: string,
): Promise<string[]> {
  const root = await ensureSolutionStore();
  const solutionDir = join(root, solutionId);
  if (!existsSync(solutionDir)) return [];
  const entries = await readdir(solutionDir, { withFileTypes: true });
  return entries
    .filter((item) => item.isDirectory() && semverValid(item.name) !== null)
    .map((item) => item.name)
    .sort((left, right) => {
      if (semverGt(left, right)) return 1;
      if (semverGt(right, left)) return -1;
      return left.localeCompare(right);
    });
}

/** True when `relativePath` exists inside the store root. */
export async function existsInStore(relativePath: string): Promise<boolean> {
  const root = await ensureSolutionStore();
  return existsSync(join(root, relativePath));
}

/** List installed solution ids (top-level directories, excluding metadata). */
export async function storeSolutions(): Promise<string[]> {
  const root = await ensureSolutionStore();
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((item) => item.isDirectory() && item.name !== "keys")
    .map((item) => item.name)
    .sort((left, right) => left.localeCompare(right));
}

/** Remove the active junction (disable) while keeping all installed files. */
export async function deactivateSolution(solutionId: string): Promise<boolean> {
  const root = await ensureSolutionStore();
  const activePath = join(root, solutionId, "active");
  if (!existsSync(activePath)) return false;
  await rm(activePath, { recursive: true, force: true });
  return true;
}

/** Delete every installed version, the active junction and lockfile entries. */
export async function removeSolution(
  solutionId: string,
): Promise<{ removedVersions: string[] }> {
  const removedVersions = await listInstalledVersions(solutionId);
  await deactivateSolution(solutionId);
  const root = await ensureSolutionStore();
  await rm(join(root, solutionId), { recursive: true, force: true });
  const lock = await readSolutionLockfile();
  lock.solutions = lock.solutions.filter(
    (item) => item.solutionId !== solutionId,
  );
  lock.activations = (lock.activations ?? []).filter(
    (item) => item.solutionId !== solutionId,
  );
  await writeSolutionLockfile(lock);
  return { removedVersions };
}

/** Activation history for one solution, newest first. */
export async function readActivationHistory(
  solutionId: string,
): Promise<Array<{ version: string; activatedAt: string }>> {
  const lock = await readSolutionLockfile();
  return (lock.activations ?? [])
    .filter((item) => item.solutionId === solutionId)
    .map((item) => ({ version: item.version, activatedAt: item.activatedAt }))
    .reverse();
}

/**
 * Delete non-active old versions, keeping the newest `keep` versions plus the
 * active version (which is always preserved). Lockfile entries and activation
 * history for removed versions are cleaned up.
 */
export async function pruneSolutionVersions(
  solutionId: string,
  keep: number,
): Promise<{ removed: string[]; kept: string[] }> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`prune_keep_invalid:String(keep)`);
  }
  const root = await ensureSolutionStore();
  const installed = await listInstalledVersions(solutionId);
  const active = await readActiveVersion(solutionId);
  const newest = installed.slice(-keep);
  const removed = installed.filter(
    (version) => !newest.includes(version) && version !== active,
  );
  for (const version of removed) {
    await rm(join(root, solutionId, version), { recursive: true, force: true });
  }
  if (removed.length > 0) {
    const lock = await readSolutionLockfile();
    lock.solutions = lock.solutions.filter(
      (item) =>
        !(item.solutionId === solutionId && removed.includes(item.version)),
    );
    lock.activations = (lock.activations ?? []).filter(
      (item) =>
        !(item.solutionId === solutionId && removed.includes(item.version)),
    );
    await writeSolutionLockfile(lock);
  }
  return {
    removed,
    kept: await listInstalledVersions(solutionId),
  };
}

/**
 * Switch the active junction back to the most recently active distinct
 * previous version and return the transition.
 */
export async function rollbackSolution(
  solutionId: string,
): Promise<{ from: string; to: string }> {
  const from = await readActiveVersion(solutionId);
  if (!from) throw new Error(`solution_not_active:${solutionId}`);
  const to = await findPreviousActiveVersion(solutionId, from);
  if (!to) throw new Error(`solution_no_previous_version:${solutionId}`);
  await activateSolution(solutionId, to);
  return { from, to };
}

async function findPreviousActiveVersion(
  solutionId: string,
  current: string,
): Promise<string | null> {
  const lock = await readSolutionLockfile();
  const history = [...(lock.activations ?? [])]
    .filter((item) => item.solutionId === solutionId)
    .reverse()
    .map((item) => item.version)
    .filter((version) => version !== current);
  const seen = new Set<string>();
  for (const version of history) {
    if (seen.has(version)) continue;
    seen.add(version);
    if (existsSync(join(await ensureSolutionStore(), solutionId, version))) {
      return version;
    }
  }
  // No activation history: fall back to the highest installed version below
  // the current one so a freshly-cloned store can still roll back.
  const installed = await listInstalledVersions(solutionId);
  const candidates = installed.filter((version) => semverGt(current, version));
  return candidates.length > 0
    ? (candidates[candidates.length - 1] ?? null)
    : null;
}

export async function resolveActiveSolutionDir(
  solutionId: string,
): Promise<string | null> {
  const root = await ensureSolutionStore();
  const activePath = join(root, solutionId, "active");
  if (!existsSync(activePath)) return null;
  return realpath(activePath);
}

export async function readSolutionLockfile(): Promise<SolutionLockfile> {
  const root = await ensureSolutionStore();
  const lockPath = join(root, "weflow-solution.lock.json");
  if (!existsSync(lockPath)) {
    return { schemaVersion: 1, solutions: [] };
  }
  return JSON.parse(await readFile(lockPath, "utf8")) as SolutionLockfile;
}

async function writeSolutionLockfile(lock: SolutionLockfile): Promise<void> {
  const root = await ensureSolutionStore();
  await writeFile(
    join(root, "weflow-solution.lock.json"),
    JSON.stringify(lock, null, 2),
    "utf8",
  );
}

async function appendLockEntry(entry: SolutionLockEntry): Promise<void> {
  const lock = await readSolutionLockfile();
  lock.solutions = lock.solutions.filter(
    (item) =>
      !(item.solutionId === entry.solutionId && item.version === entry.version),
  );
  lock.solutions.push(entry);
  await writeSolutionLockfile(lock);
}

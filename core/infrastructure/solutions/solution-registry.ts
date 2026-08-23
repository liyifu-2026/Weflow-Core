/**
 * Local Solution Registry storage.
 *
 * Layout:
 *   <root>/<solution-id>/<version>.tgz
 *   <root>/<solution-id>/index.json
 *
 * The registry stores only packages that already carry a valid
 * manifest+lock+signature triple; integrity is enforced by callers (HTTP
 * publish route verifies before writing here).
 */
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { gt as semverGt, valid as semverValid } from "semver";
import {
  describeStagedSolutionPackage,
  extractSolutionTgz,
} from "./solution-pack.js";
import type { SolutionPackageDescriptor } from "@weflow/solution-sdk";

export type RegistryPackageEntry = {
  solutionId: string;
  version: string;
  manifestDigest: string;
  size: number;
  publishedAt: string;
};

export type RegistryIndex = {
  solutionId: string;
  versions: RegistryPackageEntry[];
};

function solutionDir(root: string, solutionId: string): string {
  return join(root, solutionId);
}

export function registryTarballPath(
  root: string,
  solutionId: string,
  version: string,
): string {
  return join(solutionDir(root, solutionId), `${version}.tgz`);
}

/**
 * Accept a package tarball into the registry and update the index.
 *
 * The tarball is inspected first; the recorded solutionId/version/manifest
 * digest always come from the package itself. When the caller passes explicit
 * expectations (e.g. from the publish URL) a mismatch is rejected.
 */
export async function putRegistryPackage(input: {
  root: string;
  tgzSource: string;
  expectedSolutionId?: string;
  expectedVersion?: string;
}): Promise<RegistryPackageEntry> {
  const inspected = await inspectSolutionTarball(input.tgzSource);
  const solutionId = inspected.descriptor.manifest.metadata.id;
  const version = inspected.descriptor.manifest.metadata.version;
  if (input.expectedSolutionId && input.expectedSolutionId !== solutionId) {
    throw new Error(`solution_registry_id_mismatch:${solutionId}`);
  }
  if (input.expectedVersion && input.expectedVersion !== version) {
    throw new Error(`solution_registry_version_mismatch:${version}`);
  }
  const dir = solutionDir(input.root, solutionId);
  await mkdir(dir, { recursive: true });
  const target = registryTarballPath(input.root, solutionId, version);
  await rm(target, { force: true });
  await copyFile(input.tgzSource, target);
  const info = await stat(target);
  const entry: RegistryPackageEntry = {
    solutionId,
    version,
    manifestDigest: inspected.descriptor.manifestDigest,
    size: info.size,
    publishedAt: new Date().toISOString(),
  };
  const index = await readRegistryIndex(input.root, solutionId);
  const versions = [
    ...(index?.versions ?? []).filter((item) => item.version !== version),
    entry,
  ].sort((left, right) => {
    if (semverValid(left.version) && semverValid(right.version)) {
      if (semverGt(left.version, right.version)) return 1;
      if (semverGt(right.version, left.version)) return -1;
    }
    return left.version.localeCompare(right.version);
  });
  await writeFile(
    join(dir, "index.json"),
    JSON.stringify({ solutionId, versions }, null, 2),
    "utf8",
  );
  return entry;
}

/** Extract and describe a packaged tarball without touching the store. */
export async function inspectSolutionTarball(tgzPath: string): Promise<{
  descriptor: SolutionPackageDescriptor;
  cleanup: () => Promise<void>;
}> {
  const staging = await mkdtemp(join(tmpdir(), "weflow-registry-inspect-"));
  try {
    const extracted = await extractSolutionTgz(tgzPath, join(staging, "pkg"));
    const descriptor = await describeStagedSolutionPackage(extracted);
    return {
      descriptor,
      cleanup: async () => {
        await rm(staging, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function readRegistryIndex(
  root: string,
  solutionId: string,
): Promise<RegistryIndex | null> {
  const indexPath = join(solutionDir(root, solutionId), "index.json");
  if (!existsSync(indexPath)) return null;
  return JSON.parse(await readFile(indexPath, "utf8")) as RegistryIndex;
}

export async function readRegistryEntry(
  root: string,
  solutionId: string,
  version: string,
): Promise<RegistryPackageEntry | null> {
  const index = await readRegistryIndex(root, solutionId);
  return index?.versions.find((item) => item.version === version) ?? null;
}

/** List solution ids present in the registry (diagnostics helper). */
export async function listRegistrySolutions(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort((left, right) => left.localeCompare(right));
}

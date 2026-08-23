/**
 * `weflowctl solution doctor` — one-shot environment health report.
 *
 * Pure filesystem/network checks with actionable hints; the CLI layer only
 * renders the returned checks.
 */
import { existsSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultDevSigningKeyPath } from "./solution-pack.js";
import {
  getSolutionStoreRoot,
  listInstalledVersions,
  readActiveVersion,
  readSolutionLockfile,
} from "./solution-store.js";
import { checkSolutionVersionHealth } from "./solution-health.js";

export type DoctorCheck = {
  id: string;
  ok: boolean;
  detail?: Record<string, unknown> | undefined;
  hint?: string | undefined;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

export type SolutionDoctorOptions = {
  registryUrl?: string | undefined;
  registryToken?: string | undefined;
  fetchImpl?: typeof globalThis.fetch | undefined;
};

function check(
  id: string,
  ok: boolean,
  detail?: Record<string, unknown>,
  hint?: string,
): DoctorCheck {
  return {
    id,
    ok,
    ...(detail !== undefined ? { detail } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

/** Run every doctor check and aggregate the report. */
export async function runSolutionDoctor(
  options: SolutionDoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const storeRoot = getSolutionStoreRoot();

  // 1. Store root exists and is a directory.
  let storeUsable = false;
  if (!existsSync(storeRoot)) {
    checks.push(
      check(
        "store_root",
        false,
        { path: storeRoot },
        "Run any install command; the directory is created automatically.",
      ),
    );
  } else if (!statSync(storeRoot).isDirectory()) {
    checks.push(
      check(
        "store_root",
        false,
        { path: storeRoot },
        "The store path exists but is not a directory; fix WEFLOW_SOLUTION_STORE.",
      ),
    );
  } else {
    storeUsable = true;
    checks.push(check("store_root", true, { path: storeRoot }));
  }

  // 2. Lockfile consistency: lockfile entries must match installed versions.
  const lock = await readSolutionLockfile();
  const lockIds = new Map<string, string[]>();
  for (const entry of lock.solutions) {
    lockIds.set(entry.solutionId, [
      ...(lockIds.get(entry.solutionId) ?? []),
      entry.version,
    ]);
  }
  checks.push(check("lockfile", true, { entries: lock.solutions.length }));
  void lockIds;

  // 3-4. Per-solution checks: active junction validity + structural health.
  const solutions = storeUsable ? await listAllSolutions() : [];
  for (const solutionId of solutions) {
    const activeLink = join(storeRoot, solutionId, "active");
    const linkExists = existsSync(activeLink) || lstatSafe(activeLink);
    const active = await readActiveVersion(solutionId);
    if (linkExists && active === null) {
      checks.push(
        check(
          "active_junction",
          false,
          { solutionId },
          "The active junction is broken (target missing); run `weflowctl solution activate <id>` to repair.",
        ),
      );
      continue;
    }
    if (!linkExists || active === null) {
      // Disabled solution: not an error by itself.
      continue;
    }
    checks.push(
      check("active_junction", true, { solutionId, version: active }),
    );
    const activeDir = join(storeRoot, solutionId, active);
    const health = await checkSolutionVersionHealth(activeDir);
    if (!health.ok) {
      checks.push(
        check(
          "package_integrity",
          false,
          { solutionId, reason: health.reason },
          "Re-install the package: weflowctl solution install <id|tgz>.",
        ),
      );
    }
  }

  // Signature trust anchor: only required when packages are installed.
  const trustAnchorPub = `${defaultDevSigningKeyPath()}.pub`;
  if (solutions.length === 0 || existsSync(trustAnchorPub)) {
    checks.push(check("signature", true, { anchor: trustAnchorPub }));
  } else {
    checks.push(
      check(
        "signature",
        false,
        { anchor: trustAnchorPub },
        "Run `weflowctl solution keygen`, or configure WEFLOW_SOLUTION_TRUSTED_SIGNING_PUBLIC_KEY.",
      ),
    );
  }

  // 5. Registry reachability (only when configured).
  if (options.registryUrl !== undefined && options.registryUrl !== "") {
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    try {
      const headers: Record<string, string> = {};
      if (options.registryToken)
        headers.authorization = `Bearer ${options.registryToken}`;
      const response = await doFetch(
        `${options.registryUrl.replace(/\/$/, "")}/v1/solutions`,
        { headers },
      );
      checks.push(
        check(
          "registry",
          response.ok,
          { url: options.registryUrl, status: response.status },
          response.ok ? undefined : "Registry responded with an error status.",
        ),
      );
    } catch (error) {
      checks.push(
        check(
          "registry",
          false,
          { url: options.registryUrl },
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  // 6. Public key configuration presence.
  const envKey = process.env.WEFLOW_SOLUTION_TRUSTED_SIGNING_PUBLIC_KEY;
  checks.push(
    check(
      "public_key_config",
      Boolean(envKey) || existsSync(trustAnchorPub),
      undefined,
      "Set WEFLOW_SOLUTION_TRUSTED_SIGNING_PUBLIC_KEY for production installs.",
    ),
  );

  // 7. Orphan directories: solution folders or versions absent from lockfile.
  const orphans: Array<{ solutionId: string; versions: string[] }> = [];
  if (storeUsable) {
    for (const solutionId of solutions) {
      const installed = await listInstalledVersions(solutionId);
      const locked = new Set(
        lock.solutions
          .filter((item) => item.solutionId === solutionId)
          .map((item) => item.version),
      );
      const orphanVersions = installed.filter(
        (version) => !locked.has(version),
      );
      if (
        orphanVersions.length > 0 ||
        !lock.solutions.some((item) => item.solutionId === solutionId)
      ) {
        orphans.push({ solutionId, versions: orphanVersions });
      }
    }
    // Directory-level orphans (ids never recorded in the lockfile).
    for (const solutionId of solutions) {
      if (!orphans.some((item) => item.solutionId === solutionId)) continue;
    }
  }
  checks.push(
    orphans.length === 0
      ? check("orphans", true)
      : check(
          "orphans",
          false,
          { orphans },
          "Orphan directories are not tracked by the lockfile; remove them manually or reinstall.",
        ),
  );

  return { ok: checks.every((item) => item.ok), checks };
}

async function listAllSolutions(): Promise<string[]> {
  const { storeSolutions } = await import("./solution-store.js");
  return storeSolutions();
}

function lstatSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

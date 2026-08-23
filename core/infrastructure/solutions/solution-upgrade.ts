/**
 * npm-style Solution update orchestration on top of the solution store.
 *
 * Update flow: resolve target by strategy → pre-activation health check →
 * atomic active switch → optional post-activation probe with automatic
 * rollback. The store lockfile records every activation for rollback.
 */
import { join } from "node:path";
import {
  activateSolution,
  getSolutionStoreRoot,
  readActiveVersion,
} from "./solution-store.js";
import {
  checkSolutionVersionHealth,
  type SolutionHealthResult,
} from "./solution-health.js";
import {
  resolveUpdateTarget,
  type SolutionUpdateStrategy,
} from "./solution-update.js";

export type SolutionHealthCheckFn = (
  versionDir: string,
  version: string,
) => Promise<SolutionHealthResult>;

export type UpdateSolutionInput = {
  solutionId: string;
  strategy: SolutionUpdateStrategy;
  /** Required when strategy is "manual". */
  explicitVersion?: string;
  /**
   * Additional candidate versions (e.g. from a registry index). They only
   * influence target selection; activation still requires the version to be
   * installed in the store.
   */
  extraCandidates?: readonly string[];
  /**
   * Called when the resolved target is not installed yet. Implementations
   * typically download and install the package into the store (without
   * activating it).
   */
  ensureCandidate?: (version: string) => Promise<void>;
  /**
   * Health gate run against the target version directory before the active
   * junction is switched. Defaults to structural checks.
   */
  healthCheck?: SolutionHealthCheckFn;
  /**
   * Runtime probe executed after activation; a failure triggers an automatic
   * rollback to the previous version.
   */
  postActivationCheck?: () => Promise<SolutionHealthResult>;
};

export type UpdateSolutionOutcome =
  | { status: "updated"; from: string; to: string }
  | { status: "no-op"; current: string | null };

export async function updateSolutionInStore(
  input: UpdateSolutionInput,
): Promise<UpdateSolutionOutcome> {
  const { solutionId, strategy, explicitVersion } = input;
  const current = await readActiveVersion(solutionId);
  const { listInstalledVersions } = await import("./solution-store.js");
  const installed = await listInstalledVersions(solutionId);
  const candidates = [...installed, ...(input.extraCandidates ?? [])].filter(
    (version, index, all) => all.indexOf(version) === index,
  );

  const target = resolveUpdateTarget({
    candidates,
    current,
    strategy,
    ...(explicitVersion !== undefined ? { explicitVersion } : {}),
  });
  if (!target || target === current) {
    return { status: "no-op", current };
  }

  if (!installed.includes(target) && input.ensureCandidate) {
    await input.ensureCandidate(target);
  }
  if (!(await installedVersionExists(solutionId, target))) {
    throw new Error(`solution_version_not_in_store:${solutionId}:${target}`);
  }

  const targetDir = join(getSolutionStoreRoot(), solutionId, target);
  const gate = input.healthCheck ?? defaultGate;
  const pre = await gate(targetDir, target);
  if (!pre.ok) {
    throw new Error(`solution_health_check_failed:${target}:${pre.reason}`);
  }

  await activateSolution(solutionId, target);

  if (input.postActivationCheck) {
    const post = await input.postActivationCheck();
    if (!post.ok) {
      let restored = false;
      if (current) {
        try {
          await activateSolution(solutionId, current);
          restored = true;
        } catch {
          restored = false;
        }
      }
      throw new Error(
        `solution_update_rolled_back:${restored ? (current ?? "unknown") : "unknown"}:${post.reason}`,
      );
    }
  }

  return { status: "updated", from: current ?? "", to: target };
}

const defaultGate: SolutionHealthCheckFn = (versionDir) =>
  checkSolutionVersionHealth(versionDir);

/**
 * Roll back to an explicit version: the target must be installed and pass its
 * health gate before the active junction is switched.
 */
export async function rollbackSolutionTo(input: {
  solutionId: string;
  version: string;
  healthCheck?: SolutionHealthCheckFn;
}): Promise<{ from: string; to: string }> {
  const { solutionId, version } = input;
  const from = await readActiveVersion(solutionId);
  if (!from) throw new Error(`solution_not_active:${solutionId}`);
  if (from === version) {
    throw new Error(`solution_already_active:${solutionId}:${version}`);
  }
  const { existsSync } = await import("node:fs");
  const targetDir = join(getSolutionStoreRoot(), solutionId, version);
  if (!existsSync(targetDir)) {
    throw new Error(`solution_version_not_in_store:${solutionId}:${version}`);
  }
  const gate = input.healthCheck ?? defaultGate;
  const pre = await gate(targetDir, version);
  if (!pre.ok) {
    throw new Error(`solution_health_check_failed:${version}:${pre.reason}`);
  }
  await activateSolution(solutionId, version);
  return { from, to: version };
}

async function installedVersionExists(
  solutionId: string,
  version: string,
): Promise<boolean> {
  const { existsSync } = await import("node:fs");
  return existsSync(join(getSolutionStoreRoot(), solutionId, version));
}

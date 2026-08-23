/**
 * npm-style semver update policy for Solutions.
 *
 * Pure functions only: the caller owns I/O (store reads, package installs).
 */
import { gt as semverGt, maxSatisfying, valid as semverValid } from "semver";

export const UPDATE_STRATEGIES = ["manual", "patch", "minor", "major"] as const;
export type SolutionUpdateStrategy = (typeof UPDATE_STRATEGIES)[number];

/** Type guard for update strategy strings coming from CLI/config input. */
export function isSolutionUpdateStrategy(
  value: string,
): value is SolutionUpdateStrategy {
  return (UPDATE_STRATEGIES as readonly string[]).includes(value);
}

export type ResolveUpdateTargetInput = {
  /** Installed (or registry) candidate versions; invalid entries are ignored. */
  candidates: string[];
  /** Currently active version, or null when the solution is not installed. */
  current: string | null;
  strategy: SolutionUpdateStrategy;
  /** Required when strategy is "manual"; must be a known candidate. */
  explicitVersion?: string;
};

/**
 * Pick the target version for an update, or null when no upgrade is
 * available under the strategy. Never returns a downgrade or the current
 * version.
 */
export function resolveUpdateTarget(
  input: ResolveUpdateTargetInput,
): string | null {
  const { candidates, current, strategy, explicitVersion } = input;
  if (current === null) return null;

  const valid = candidates.filter((version) => semverValid(version) !== null);

  if (strategy === "manual") {
    if (!explicitVersion) return null;
    if (!valid.includes(explicitVersion)) return null;
    return semverGt(explicitVersion, current) ? explicitVersion : null;
  }

  const range =
    strategy === "patch"
      ? `~${current}`
      : strategy === "minor"
        ? `^${current}`
        : "*";
  const inRange = maxSatisfying(valid, range);
  if (!inRange || !semverGt(inRange, current)) return null;
  return inRange;
}

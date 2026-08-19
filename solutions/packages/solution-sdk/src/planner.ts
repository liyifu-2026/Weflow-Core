import { digestOf } from "./canonical.js";
import type {
  ArtifactDownload,
  Blocker,
  CapabilityConflict,
  CompatibilityResult,
  InstallPlan,
  PlannerInput,
  ResourceChange,
  SolutionMigration,
} from "./types.js";

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return [0, 0, 0];
  return [
    Number(match[1] ?? 0),
    Number(match[2] ?? 0),
    Number(match[3] ?? 0),
  ];
}

function compareVersions(a: string, b: string): number {
  const [amaj, amin, apatch] = parseVersion(a);
  const [bmaj, bmin, bpatch] = parseVersion(b);
  if (amaj !== bmaj) return amaj - bmaj;
  if (amin !== bmin) return amin - bmin;
  return apatch - bpatch;
}

function satisfiesClause(version: string, clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed === "" || trimmed === "*") return true;
  if (trimmed.startsWith(">=")) {
    return compareVersions(version, trimmed.slice(2)) >= 0;
  }
  if (trimmed.startsWith("<=")) {
    return compareVersions(version, trimmed.slice(2)) <= 0;
  }
  if (trimmed.startsWith(">")) {
    return compareVersions(version, trimmed.slice(1)) > 0;
  }
  if (trimmed.startsWith("<")) {
    return compareVersions(version, trimmed.slice(1)) < 0;
  }
  if (trimmed.startsWith("=")) {
    return compareVersions(version, trimmed.slice(1)) === 0;
  }
  if (trimmed.startsWith("^")) {
    const [major] = parseVersion(trimmed.slice(1));
    const [vmajor] = parseVersion(version);
    if (major === 0) {
      return vmajor === 0 && compareVersions(version, trimmed.slice(1)) >= 0;
    }
    return vmajor === major && compareVersions(version, trimmed.slice(1)) >= 0;
  }
  if (trimmed.startsWith("~")) {
    const [major, minor] = parseVersion(trimmed.slice(1));
    const [vmajor, vminor] = parseVersion(version);
    return (
      vmajor === major &&
      vminor === minor &&
      compareVersions(version, trimmed.slice(1)) >= 0
    );
  }
  return compareVersions(version, trimmed) === 0;
}

export function satisfiesVersion(version: string, range: string): boolean {
  const clauses = range.split(/\s+/).filter((clause) => clause.length > 0);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => satisfiesClause(version, clause));
}

function findLockArtifact(
  input: PlannerInput,
  artifactId: string,
): { ref: string; registry: string; digest: string } | undefined {
  const locked = input.descriptor.lock.artifacts.find(
    (artifact) => artifact.id === artifactId,
  );
  if (!locked) return undefined;
  const catalog = input.artifactCatalog.find(
    (artifact) => artifact.id === artifactId,
  );
  return {
    ref: locked.ref,
    registry: locked.registry ?? catalog?.registry ?? "unknown",
    digest: locked.digest,
  };
}

function computeCompatibility(
  input: PlannerInput,
): CompatibilityResult {
  const manifest = input.descriptor.manifest;
  const platformRange = manifest.compatibility.platform;
  const platformCompatible = satisfiesVersion(
    input.platformVersion,
    platformRange,
  );
  let pluginSdkCompatible = true;
  let pluginSdkRange: string | undefined;
  if (manifest.compatibility.pluginSdk && input.pluginSdkVersion) {
    pluginSdkRange = manifest.compatibility.pluginSdk;
    pluginSdkCompatible = satisfiesVersion(
      input.pluginSdkVersion,
      manifest.compatibility.pluginSdk,
    );
  }
  const compatible = platformCompatible && pluginSdkCompatible;
  return {
    compatible,
    platformRange,
    platformVersion: input.platformVersion,
    ...(pluginSdkRange === undefined ? {} : { pluginSdkRange }),
    ...(compatible
      ? {}
      : {
          reason: platformCompatible
            ? "plugin SDK range not satisfied"
            : "platform version not satisfied",
        }),
  };
}

export function planSolution(input: PlannerInput): InstallPlan {
  const manifest = input.descriptor.manifest;
  const blockers: Blocker[] = [];
  const compatibility = computeCompatibility(input);

  if (!compatibility.compatible) {
    blockers.push({
      code: "incompatible_platform",
      message: compatibility.reason ?? "platform compatibility check failed",
    });
  }

  const dependencyOrder = [...manifest.dependencies.solutions];
  for (const dependency of manifest.dependencies.solutions) {
    const installed = input.installedSolutions.find(
      (solution) => solution.id === dependency,
    );
    if (!installed || installed.observedState === "absent") {
      blockers.push({
        code: "missing_solution_dependency",
        message: `required solution dependency "${dependency}" is not installed`,
      });
    }
  }

  const capabilityConflicts: CapabilityConflict[] = [];
  for (const capability of manifest.dependencies.capabilities) {
    const providers = input.capabilityCatalog.filter(
      (entry) => entry.id === capability,
    );
    if (providers.length === 0) {
      blockers.push({
        code: "missing_capability",
        message: `required capability "${capability}" is not available`,
      });
    } else if (providers.length > 1) {
      capabilityConflicts.push({
        capability,
        existingProvider: providers[0]?.providedBy ?? "unknown",
        ...(providers[1] === undefined
          ? {}
          : { requestedProvider: providers[1]?.providedBy }),
      });
    }
  }

  const missingSecrets = manifest.secretSlots
    .filter(
      (slot) =>
        slot.required && !input.secretInventory.configured.includes(slot.name),
    )
    .map((slot) => slot.name);

  const artifactDownloads: ArtifactDownload[] = [];
  for (const artifact of manifest.artifacts) {
    const locked = findLockArtifact(input, artifact.id);
    if (!locked) {
      blockers.push({
        code: "missing_locked_artifact",
        message: `artifact "${artifact.id}" is missing from solution.lock.json`,
      });
      continue;
    }
    artifactDownloads.push({
      id: artifact.id,
      ref: locked.ref,
      registry: locked.registry,
      digest: locked.digest,
    });
  }

  const migrations: SolutionMigration[] = [];
  for (const resource of manifest.resources) {
    if (resource.type !== "schema" && resource.type !== "ledger") continue;
    const locked = findLockArtifact(input, resource.id);
    if (!locked) {
      blockers.push({
        code: "missing_migration_digest",
        message: `migration resource "${resource.id}" is missing from solution.lock.json`,
      });
      continue;
    }
    migrations.push({
      id: resource.id,
      schema: resource.ref,
      digest: locked.digest,
    });
  }

  const resources: ResourceChange[] = manifest.resources.map((resource) => ({
    id: resource.id,
    type: resource.type,
    action: "create",
  }));

  const restartProcesses = [...input.runtimeState.processes];
  const healthChecks = manifest.healthChecks;

  const existing = input.installedSolutions.find(
    (solution) => solution.id === manifest.metadata.id,
  );
  const rollbackVersion =
    existing && existing.version !== manifest.metadata.version
      ? existing.version
      : null;

  const permissionAdditions = manifest.permissions;

  const planWithoutDigest = {
    solutionId: manifest.metadata.id,
    solutionVersion: manifest.metadata.version,
    compatibility,
    dependencyOrder,
    capabilityConflicts,
    permissionAdditions,
    missingSecrets,
    artifactDownloads,
    migrations,
    restartProcesses,
    resources,
    healthChecks,
    rollbackVersion,
    blockers,
  };

  const planDigest = digestOf(planWithoutDigest);

  return {
    planDigest,
    ...planWithoutDigest,
  };
}

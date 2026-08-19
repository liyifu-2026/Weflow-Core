import {
  addIssue,
  fail,
  hasUniqueIds,
  ok,
  parseStrictObject,
  readNumber,
  readOptionalString,
  readString,
  type ValidationResult,
} from "./validate.js";
import type {
  LockedArtifact,
  LockedDependency,
  SolutionLockV1,
} from "./types.js";

const LOCK_KEYS = new Set([
  "apiVersion",
  "kind",
  "solutionId",
  "solutionVersion",
  "manifestDigest",
  "dependencies",
  "artifacts",
  "targetPlatform",
  "targetArchitecture",
  "sbom",
]);

const DEPENDENCY_KEYS = new Set(["id", "version", "registry", "digest"]);
const ARTIFACT_KEYS = new Set([
  "id",
  "ref",
  "registry",
  "digest",
  "size",
  "platform",
  "architecture",
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function isValidSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

function isValidDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

function readId(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: { path: string; message: string }[],
): string | undefined {
  const value = readString(obj, key, path, issues);
  if (value !== undefined && !isValidId(value)) {
    addIssue(issues, `${path}.${key}`, `invalid id "${value}"`);
    return undefined;
  }
  return value;
}

function readVersion(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: { path: string; message: string }[],
): string | undefined {
  const value = readString(obj, key, path, issues);
  if (value !== undefined && !isValidSemVer(value)) {
    addIssue(issues, `${path}.${key}`, `invalid semantic version "${value}"`);
    return undefined;
  }
  return value;
}

function readDigest(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: { path: string; message: string }[],
): string | undefined {
  const value = readString(obj, key, path, issues);
  if (value !== undefined && !isValidDigest(value)) {
    addIssue(issues, `${path}.${key}`, `invalid digest "${value}"`);
    return undefined;
  }
  return value;
}

function parseDependency(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): LockedDependency | null {
  const obj = parseStrictObject(input, DEPENDENCY_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const version = readVersion(obj, "version", path, issues);
  const registry = readOptionalString(obj, "registry", path, issues);
  const digest = readDigest(obj, "digest", path, issues);
  if (!id || !version || !digest) return null;
  return {
    id,
    version,
    ...(registry === undefined ? {} : { registry }),
    digest,
  };
}

function parseArtifact(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): LockedArtifact | null {
  const obj = parseStrictObject(input, ARTIFACT_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const ref = readString(obj, "ref", path, issues);
  const registry = readOptionalString(obj, "registry", path, issues);
  const digest = readDigest(obj, "digest", path, issues);
  const size = readNumber(obj, "size", path, issues, {
    required: false,
    integer: true,
    min: 0,
  });
  const platform = readOptionalString(obj, "platform", path, issues);
  const architecture = readOptionalString(obj, "architecture", path, issues);
  if (!id || !ref || !digest) return null;
  return {
    id,
    ref,
    ...(registry === undefined ? {} : { registry }),
    digest,
    ...(size === undefined ? {} : { size }),
    ...(platform === undefined ? {} : { platform }),
    ...(architecture === undefined ? {} : { architecture }),
  };
}

export function validateSolutionLock(
  input: unknown,
): ValidationResult<SolutionLockV1> {
  const issues: { path: string; message: string }[] = [];
  const obj = parseStrictObject(input, LOCK_KEYS, "$", issues);
  if (!obj) return fail(issues);

  if (obj.apiVersion !== "weflow.io/v1") {
    addIssue(issues, "$.apiVersion", 'must be "weflow.io/v1"');
  }
  if (obj.kind !== "SolutionLock") {
    addIssue(issues, "$.kind", 'must be "SolutionLock"');
  }

  const solutionId = readId(obj, "solutionId", "$", issues);
  const solutionVersion = readVersion(obj, "solutionVersion", "$", issues);
  const manifestDigest = readDigest(obj, "manifestDigest", "$", issues);
  const targetPlatform = readOptionalString(obj, "targetPlatform", "$", issues);
  const targetArchitecture = readOptionalString(
    obj,
    "targetArchitecture",
    "$",
    issues,
  );
  const sbom = readOptionalString(obj, "sbom", "$", issues);

  const dependenciesInput = obj.dependencies;
  const dependencies: LockedDependency[] = [];
  if (dependenciesInput === undefined) {
    addIssue(issues, "$.dependencies", "field is required");
  } else if (!Array.isArray(dependenciesInput)) {
    addIssue(issues, "$.dependencies", "expected an array");
  } else {
    dependenciesInput.forEach((item, index) => {
      const dependency = parseDependency(item, `$.dependencies[${index}]`, issues);
      if (dependency) dependencies.push(dependency);
    });
    hasUniqueIds(dependencies, "$.dependencies", issues);
  }

  const artifactsInput = obj.artifacts;
  const artifacts: LockedArtifact[] = [];
  if (artifactsInput === undefined) {
    addIssue(issues, "$.artifacts", "field is required");
  } else if (!Array.isArray(artifactsInput)) {
    addIssue(issues, "$.artifacts", "expected an array");
  } else {
    artifactsInput.forEach((item, index) => {
      const artifact = parseArtifact(item, `$.artifacts[${index}]`, issues);
      if (artifact) artifacts.push(artifact);
    });
    hasUniqueIds(artifacts, "$.artifacts", issues);
  }

  if (issues.length > 0) return fail(issues);
  if (!solutionId || !solutionVersion || !manifestDigest || !dependencies || !artifacts) {
    return fail(issues);
  }

  return ok({
    apiVersion: "weflow.io/v1",
    kind: "SolutionLock",
    solutionId,
    solutionVersion,
    manifestDigest,
    dependencies,
    artifacts,
    ...(targetPlatform === undefined ? {} : { targetPlatform }),
    ...(targetArchitecture === undefined ? {} : { targetArchitecture }),
    ...(sbom === undefined ? {} : { sbom }),
  });
}

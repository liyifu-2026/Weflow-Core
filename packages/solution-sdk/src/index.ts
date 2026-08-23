/**
 * @weflow/solution-sdk — Node entry.
 *
 * npm-style Solution package contract: manifest/lock/signature schemas,
 * canonical digests, package descriptors and ed25519 signature verification.
 * The browser-safe subset lives in `schema.ts`; this entry adds Node crypto.
 */
import { createHash, verify as verifySignature } from "node:crypto";
import {
  canonicalJson,
  normalizeSolutionManifest,
  parseSolutionLock,
  parseSolutionManifest,
  solutionSignatureSchema,
  type SolutionDescriptor,
  type SolutionLockV1,
  type SolutionPackageFiles,
  type SolutionPackageDescriptor,
  type SolutionSignature,
} from "./schema.js";

export * from "./schema.js";

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function describeSolution(input: unknown): SolutionDescriptor {
  const manifest = normalizeSolutionManifest(parseSolutionManifest(input));
  return {
    manifest,
    manifestDigest: sha256Digest(manifest),
  };
}

/** Validate the three package files as one immutable package boundary. */
export function describeSolutionPackage(
  input: SolutionPackageFiles,
): SolutionPackageDescriptor {
  const descriptor = describeSolution(input.manifest);
  const lock: SolutionLockV1 = parseSolutionLock(input.lock);
  const signature: SolutionSignature =
    solutionSignatureSchema.parse(input.signature);
  if (lock.solutionId !== descriptor.manifest.metadata.id)
    throw new Error("solution_lock_id_mismatch");
  if (lock.solutionVersion !== descriptor.manifest.metadata.version)
    throw new Error("solution_lock_version_mismatch");
  if (lock.manifestDigest !== descriptor.manifestDigest)
    throw new Error("solution_lock_manifest_digest_mismatch");
  const artifactIds = new Set(
    descriptor.manifest.artifacts.map((item) => item.id),
  );
  const resolvedIds = new Set<string>();
  for (const artifact of lock.resolvedArtifacts) {
    if (resolvedIds.has(artifact.id))
      throw new Error("solution_lock_duplicate_artifact");
    resolvedIds.add(artifact.id);
    if (!artifactIds.has(artifact.id))
      throw new Error("solution_lock_unknown_artifact");
  }
  if (resolvedIds.size !== artifactIds.size)
    throw new Error("solution_lock_artifact_set_incomplete");
  return { ...descriptor, lock, lockDigest: sha256Digest(lock), signature };
}

export function verifySolutionSignature(
  descriptor: SolutionDescriptor,
  signature: SolutionSignature,
  publicKey: string | Buffer,
): boolean {
  const parsed = solutionSignatureSchema.parse(signature);
  if (!descriptor.lock) return false;
  const payload = Buffer.from(
    `${descriptor.manifestDigest}:${sha256Digest(descriptor.lock)}`,
    "utf8",
  );
  return verifySignature(
    null,
    payload,
    publicKey,
    Buffer.from(parsed.signature, "base64"),
  );
}

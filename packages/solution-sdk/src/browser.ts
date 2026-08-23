/**
 * Browser-safe entry for @weflow/solution-sdk.
 *
 * The Node entry uses node:crypto for synchronous digests and signatures.
 * This entry exposes the pure schema validators plus a Web Crypto digest so
 * Console/Vite can validate manifests and locks without pulling Node
 * built-ins into the browser bundle.
 */
import {
  canonicalJson,
  type SolutionLockV1,
  type SolutionManifestV1,
} from "./schema.js";

export {
  canonicalJson,
  normalizeSolutionManifest,
  parseSolutionLock,
  parseSolutionManifest,
  solutionLockSchema,
  solutionManifestSchema,
  solutionSignatureSchema,
  validateSolutionLock,
  validateSolutionManifest,
} from "./schema.js";
export type {
  ExecutionProfile,
  HealthCheck,
  SolutionApplication,
  SolutionArtifact,
  SolutionCompatibility,
  SolutionConsoleExtension,
  SolutionDependencies,
  SolutionDescriptor,
  SolutionLockV1,
  SolutionManifestValidationResult,
  SolutionLockValidationResult,
  SolutionMetadata,
  SolutionPackageDescriptor,
  SolutionPackageFiles,
  SolutionPermission,
  SolutionResource,
  SolutionSecretSlot,
  SolutionSignature,
} from "./schema.js";

/**
 * Deterministic payload digest over the manifest+lock pair, computed with
 * Web Crypto. Same `sha256:` framing as the Node entry.
 */
export async function solutionPayloadDigestBrowser(
  manifest: SolutionManifestV1,
  lock: SolutionLockV1,
): Promise<string> {
  const canonical = canonicalJson({ lock, manifest });
  const data = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return `sha256:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

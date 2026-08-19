/**
 * Browser-safe entry for @weflow/solution-sdk.
 *
 * The main entry uses node:crypto for synchronous digests and signatures.
 * This entry uses Web Crypto so Console/Vite can consume validators and the
 * payload digest without pulling Node built-ins into the browser bundle.
 */
import { validateSolutionLock } from "./lock.js";
import { validateSolutionManifest } from "./manifest.js";
import type { SolutionLockV1, SolutionManifestV1 } from "./types.js";

export { validateSolutionLock, validateSolutionManifest };
export type { SolutionLockV1, SolutionManifestV1 } from "./types.js";
export type { ValidationIssue, ValidationResult } from "./validate.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = canonicalize(record[key]);
      if (item !== undefined) result[key] = item;
    }
    return result;
  }
  return value;
}

export async function solutionPayloadDigestBrowser(
  manifest: SolutionManifestV1,
  lock: SolutionLockV1,
): Promise<string> {
  const canonical = JSON.stringify(canonicalize({ manifest, lock }));
  const data = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return `sha256:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

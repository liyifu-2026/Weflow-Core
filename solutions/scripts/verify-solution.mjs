/**
 * Verify one Solution pack directory against the canonical
 * `@weflow/solution-sdk` (single source of verification, no local logic).
 *
 * Usage: node scripts/verify-solution.mjs <solution-dir>
 *
 * Checks: manifest/lock/signature triple consistency via the SDK, then
 * on-disk artifact digest verification. This script only parses arguments and
 * calls the SDK — all validation logic lives in the SDK.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sdkRoot = resolve(process.argv[3] ?? "../weflow/packages/solution-sdk");
const { describeSolutionPackage, assertSolutionArtifacts } = await import(
  pathToFileURL(resolve(sdkRoot, "dist/index.js")).href
);

const input = process.argv[2] ?? "solutions/customer-support";
const solutionDir = resolve(input);

if (
  !existsSync(resolve(solutionDir, "solution.manifest.json")) &&
  !existsSync(resolve(solutionDir, "solution.manifest.yaml"))
) {
  console.error(`FAIL ${solutionDir}: solution manifest not found`);
  process.exit(1);
}

const readJson = async (name) =>
  JSON.parse(await readFile(resolve(solutionDir, name), "utf8"));

try {
  const descriptor = describeSolutionPackage({
    manifest: await readJson("solution.manifest.json"),
    lock: await readJson("solution.lock.json"),
    signature: await readJson("signature.json"),
  });
  console.log(
    `PASS ${solutionDir}: ${descriptor.manifest.metadata.id}@${descriptor.manifest.metadata.version} (manifest+lock+signature consistent)`,
  );

  const artifacts = assertSolutionArtifacts(descriptor, solutionDir);
  console.log(`PASS ${solutionDir}: ${artifacts.length} artifact digests verified`);
} catch (error) {
  console.error(`FAIL ${solutionDir}:`, error instanceof Error ? error.message : error);
  process.exit(1);
}

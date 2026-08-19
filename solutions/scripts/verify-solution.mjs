/**
 * Verify one Solution pack directory with the local @weflow/solution-sdk.
 *
 * Usage: node scripts/verify-solution.mjs <solution-dir>
 *
 * Checks: manifest schema, lock schema, manifest/lock id consistency,
 * artifact digests (file registry). Signature verification is skipped when
 * the pack carries a dev-unsigned placeholder and no public key ships in the
 * repo (see README "Signing").
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const solutionDir = resolve(root, process.argv[2] ?? "solutions/customer-support");

const { validateSolutionManifest, validateSolutionLock, manifestDigest } = await import(
  pathToFileURL(resolve(root, "packages/solution-sdk/dist/index.js")).href
);

function assertValid(result, label) {
  if (result.ok) {
    console.log(`PASS ${label}`);
    return;
  }
  console.error(`FAIL ${label}`);
  for (const issue of result.issues) {
    console.error(`  ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}

const manifest = JSON.parse(
  await readFile(resolve(solutionDir, "solution.manifest.json"), "utf8"),
);
const lock = JSON.parse(
  await readFile(resolve(solutionDir, "solution.lock.json"), "utf8"),
);

assertValid(
  validateSolutionManifest(manifest),
  `${solutionDir}: solution.manifest.json`,
);
assertValid(validateSolutionLock(lock), `${solutionDir}: solution.lock.json`);

if (lock.solutionId !== manifest.metadata.id) {
  console.error(
    `FAIL ${solutionDir}: lock.solutionId ${lock.solutionId} != manifest id ${manifest.metadata.id}`,
  );
  process.exit(1);
}
console.log(`PASS ${solutionDir}: manifest/lock id consistency`);

const expectedManifestDigest = manifestDigest(manifest);
if (lock.manifestDigest !== expectedManifestDigest) {
  console.error(
    `FAIL ${solutionDir}: lock.manifestDigest ${lock.manifestDigest} != canonical manifest digest ${expectedManifestDigest}`,
  );
  process.exit(1);
}
console.log(`PASS ${solutionDir}: lock.manifestDigest matches manifest`);

// Artifact digest check for file-registry artifacts.
for (const artifact of lock.artifacts ?? []) {
  if (artifact.registry !== "file") continue;
  const artifactPath = resolve(solutionDir, artifact.ref);
  try {
    const info = await stat(artifactPath);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    console.error(`FAIL ${solutionDir}: artifact ${artifact.ref} missing`);
    process.exit(1);
  }
  const digest = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
  const expected = artifact.digest.replace(/^sha256:/, "");
  if (digest !== expected) {
    console.error(
      `FAIL ${solutionDir}: artifact ${artifact.ref} digest mismatch (expected ${expected}, got ${digest})`,
    );
    process.exit(1);
  }
  console.log(`PASS ${solutionDir}: artifact digest ${artifact.ref}`);
}

// Signature: dev-unsigned placeholders are skipped when no public key is
// available in the repo.
const signature = JSON.parse(
  await readFile(resolve(solutionDir, "signature.json"), "utf8"),
);
if (signature.keyId === "dev-key" || signature.keyId?.startsWith("dev-")) {
  console.log(`SKIP ${solutionDir}: signature verification (dev-unsigned placeholder)`);
} else {
  console.log(
    `INFO ${solutionDir}: signature keyId=${signature.keyId}; verification requires the platform public key`,
  );
}

console.log(`\nverify ${solutionDir}: PASS`);

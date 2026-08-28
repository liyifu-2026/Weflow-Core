/**
 * Pack one Solution directory: rebuild plugin artifacts, regenerate
 * solution.lock.json digests and re-sign the manifest.
 *
 * Usage: node scripts/pack-solution.mjs <solution-dir> [sdk-root]
 *
 * What it does:
 * 1. npm pack each plugin listed in solution.manifest.json (artifacts with
 *    kind "plugin") into <solution>/artifacts/<artifact-id>.tgz
 * 2. Recompute sha256 digest + size for every resolved artifact in
 *    solution.lock.json
 * 3. Update lock.manifestDigest / lock.solutionVersion from the manifest
 * 4. Sign `manifestDigest:lockDigest` with the local dev Ed25519 key
 *    (.dev-secrets/ed25519-dev.pem, gitignored) and rewrite signature.json
 *
 * Requires: plugin dependencies installed and built (pnpm build).
 * SDK resolution: canonical @weflow/solution-sdk dist from the platform repo
 * (argv[3] overrides).
 */
import { createPublicKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const solutionDir = resolve(root, process.argv[2] ?? "solutions/customer-support");
const artifactsDir = resolve(solutionDir, "artifacts");
const secretsDir = resolve(root, ".dev-secrets");
const devKeyPath = resolve(secretsDir, "ed25519-dev.pem");
const sdkRoot =
  process.argv[3] ?? resolve(root, "../weflow/packages/solution-sdk");

const sdk = await import(pathToFileURL(resolve(sdkRoot, "dist/index.js")).href);
const { sha256Digest, describeSolution, verifySolutionSignature, digestArtifactPath } = sdk;

function readJson(relative) {
  return JSON.parse(readFileSync(resolve(solutionDir, relative), "utf8"));
}
function writeJson(relative, value) {
  writeFileSync(resolve(solutionDir, relative), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function artifactRef(entry) {
  return typeof entry.ref === "string" ? entry.ref.replace(/^file:|^npm:/, "") : "";
}

// 1. Rebuild plugin artifacts via npm pack (manifest kind "plugin").
const manifest = readJson("solution.manifest.json");
let packed = 0;
for (const artifact of manifest.artifacts ?? []) {
  if (artifact.kind !== "plugin") continue;
  const pluginDir = resolve(solutionDir, "plugins", artifact.id);
  if (!existsSync(resolve(pluginDir, "package.json"))) {
    console.error(`FAIL plugin dir missing: ${pluginDir}`);
    process.exit(1);
  }
  mkdirSync(artifactsDir, { recursive: true });
  const tgz = execFileSync("npm", ["pack", "--pack-destination", artifactsDir, "--silent"], {
    cwd: pluginDir,
    encoding: "utf8",
    shell: process.platform === "win32",
  }).trim();
  const packedPath = resolve(artifactsDir, tgz);
  const targetPath = resolve(artifactsDir, `${artifact.id}.tgz`);
  if (packedPath !== targetPath) {
    renameSync(packedPath, targetPath);
  }
  packed += 1;
  console.log(`packed ${artifact.id} -> artifacts/${artifact.id}.tgz`);
}

// 2. Reconcile lock.resolvedArtifacts with the manifest artifact set, then
// recompute digests/sizes for every ref that resolves to a real file.
// Non-plugin artifacts (web/mobile apps) are packed as real tgz files into
// artifacts/ so every lock ref is a verifiable on-disk file.
const lock = readJson("solution.lock.json");
const manifestArtifacts = manifest.artifacts ?? [];
const previous = new Map(
  (lock.resolvedArtifacts ?? []).map((item) => [item.id, item]),
);
const resolved = [];
for (const artifact of manifestArtifacts) {
  const ref = `artifacts/${artifact.id}.tgz`;
  const targetPath = resolve(solutionDir, ref);
  mkdirSync(artifactsDir, { recursive: true });
  if (artifact.kind === "plugin") {
    // packed in step 1
  } else {
    const sourceDir = resolve(solutionDir, artifactRef(artifact));
    if (!existsSync(resolve(sourceDir, "package.json"))) {
      console.error(`FAIL app dir missing package.json: ${sourceDir}`);
      process.exit(1);
    }
    const tgz = execFileSync("npm", ["pack", "--pack-destination", artifactsDir, "--silent"], {
      cwd: sourceDir,
      encoding: "utf8",
      shell: process.platform === "win32",
    }).trim();
    const packedPath = resolve(artifactsDir, tgz);
    if (packedPath !== targetPath) {
      renameSync(packedPath, targetPath);
    }
  }
  const digestInfo = await digestArtifactPath(targetPath);
  resolved.push({
    id: artifact.id,
    ref,
    digest: digestInfo.digest,
    size: digestInfo.size,
  });
  const before = previous.get(artifact.id);
  console.log(
    `digest ${artifact.id}: ${digestInfo.digest} (${digestInfo.size} bytes)` +
      (before && before.digest !== digestInfo.digest ? " [changed]" : ""),
  );
}
lock.resolvedArtifacts = resolved;

// 3. Sync lock identity fields with the manifest and recompute manifestDigest.
lock.solutionId = manifest.metadata.id;
lock.solutionVersion = manifest.metadata.version;
lock.manifestDigest = describeSolution(manifest).manifestDigest;
writeJson("solution.lock.json", lock);
console.log(`lock.manifestDigest = ${lock.manifestDigest}`);

// 4. Sign manifestDigest:lockDigest with the dev Ed25519 key.
if (!existsSync(devKeyPath)) {
  mkdirSync(secretsDir, { recursive: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(devKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), "utf8");
  console.log(`generated dev signing key ${devKeyPath} (gitignored)`);
}
const privateKeyPem = readFileSync(devKeyPath, "utf8");
const lockDigest = sha256Digest(lock);
const payload = Buffer.from(`${lock.manifestDigest}:${lockDigest}`, "utf8");
const signatureBase64 = cryptoSign(null, payload, privateKeyPem).toString("base64");
writeJson("signature.json", {
  algorithm: "ed25519",
  keyId: "dev-key",
  signature: signatureBase64,
});
console.log(`signature.json updated (keyId=dev-key, digest=${lockDigest})`);

// Self-check: the verify path must accept what we just wrote.
const descriptorMod = await import(
  pathToFileURL(resolve(sdkRoot, "dist/index.js")).href
);
const descriptor = descriptorMod.describeSolutionPackage({
  manifest,
  lock: readJson("solution.lock.json"),
  signature: readJson("signature.json"),
});
const signatureOk = verifySolutionSignature(
  descriptor,
  readJson("signature.json"),
  createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }),
);
console.log(`signature self-check: ${signatureOk ? "PASS" : "FAIL"}`);
if (!signatureOk) process.exit(1);
console.log(`\npack ${solutionDir}: done (${packed} plugin artifacts rebuilt)`);

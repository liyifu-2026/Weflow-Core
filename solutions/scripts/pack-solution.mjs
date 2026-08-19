/**
 * Pack one Solution directory: rebuild plugin artifacts, regenerate
 * solution.lock.json digests and re-sign the manifest.
 *
 * Usage: node scripts/pack-solution.mjs <solution-dir>
 *
 * What it does:
 * 1. npm pack each plugin listed in solution.manifest.json (artifacts with
 *    type "plugin") into <solution>/artifacts/<artifact-id>.tgz
 * 2. Recompute sha256 digest + size for every file-registry artifact in
 *    solution.lock.json (non-plugin artifacts are kept as-is)
 * 3. Update lock.manifestDigest to the canonical manifest digest
 * 4. Sign the manifest with the local dev Ed25519 key
 *    (.dev-secrets/ed25519-dev.pem, gitignored) and rewrite signature.json
 *
 * Requires: plugin dependencies installed and built (pnpm build).
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const solutionDir = resolve(root, process.argv[2] ?? "solutions/customer-support");
const artifactsDir = resolve(solutionDir, "artifacts");
const secretsDir = resolve(root, ".dev-secrets");
const devKeyPath = resolve(secretsDir, "ed25519-dev.pem");

const { manifestDigest, signDocument } = await import(
  pathToFileURL(resolve(root, "packages/solution-sdk/dist/index.js")).href
);

function readJson(relative) {
  return JSON.parse(readFileSync(resolve(solutionDir, relative), "utf8"));
}
function writeJson(relative, value) {
  writeFileSync(resolve(solutionDir, relative), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function artifactRef(entry) {
  return typeof entry.ref === "string" ? entry.ref.replace(/^npm:/, "") : "";
}

// 1. Rebuild plugin artifacts via npm pack.
const manifest = readJson("solution.manifest.json");
let packed = 0;
for (const artifact of manifest.artifacts ?? []) {
  if (artifact.type !== "plugin") continue;
  const pkgRef = artifactRef(artifact);
  if (!pkgRef) {
    console.error(`skip plugin artifact ${artifact.id}: no npm ref`);
    continue;
  }
  const pluginDir = resolve(solutionDir, "plugins", artifact.id);
  if (!existsSync(resolve(pluginDir, "package.json"))) {
    console.error(`FAIL plugin dir missing: ${pluginDir}`);
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(resolve(pluginDir, "package.json"), "utf8"));
  if (pkg.name !== pkgRef) {
    console.error(`FAIL artifact ${artifact.id}: package name ${pkg.name} != manifest ref ${pkgRef}`);
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

// 2. Recompute lock artifact digests/sizes.
const lock = readJson("solution.lock.json");
for (const artifact of lock.artifacts ?? []) {
  if (artifact.registry !== "file") continue;
  const artifactPath = resolve(solutionDir, artifact.ref);
  if (!existsSync(artifactPath)) {
    console.error(`FAIL artifact missing: ${artifact.ref}`);
    process.exit(1);
  }
  artifact.digest = `sha256:${sha256File(artifactPath)}`;
  artifact.size = statSync(artifactPath).size;
  console.log(`digest ${artifact.ref}: ${artifact.digest} (${artifact.size} bytes)`);
}

// 3. Update lock.manifestDigest.
lock.manifestDigest = manifestDigest(manifest);
writeJson("solution.lock.json", lock);
console.log(`lock.manifestDigest = ${lock.manifestDigest}`);

// 4. Sign the manifest with the dev Ed25519 key.
if (!existsSync(devKeyPath)) {
  mkdirSync(secretsDir, { recursive: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(devKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), "utf8");
  console.log(`generated dev signing key ${devKeyPath} (gitignored)`);
}
const privateKeyPem = readFileSync(devKeyPath, "utf8");
const signature = signDocument(manifest, { keyId: "dev-key", privateKeyPem });
writeJson("signature.json", signature);
console.log(`signature.json updated (keyId=dev-key, digest=${signature.digest})`);

console.log(`\npack ${solutionDir}: done (${packed} plugin artifacts rebuilt)`);

/**
 * Verify Solution pack directories with the canonical `@weflow/solution-sdk`.
 *
 * Usage: node scripts/solution-verify.mjs <package-dir> [more-dirs...]
 *
 * This script only parses arguments and calls the SDK. All verification
 * logic (manifest/lock/signature consistency, artifact path safety and
 * sha256 digests) lives in the SDK — do not add checks here.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(projectDir, script, label = `${projectDir} ${script.join(" ")}`) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(
    "pnpm",
    ["--dir", resolve(root, projectDir), ...script],
    { cwd: root, stdio: "inherit", env: process.env, shell: process.platform === "win32" },
  );
  if (result.status !== 0) {
    process.stderr.write(`\nFAILED: ${label} (exit ${String(result.status)})\n`);
    process.exit(result.status ?? 1);
  }
}

// SDK dist must be current before importing it below.
run("packages/solution-sdk", ["build"], "build @weflow/solution-sdk");

const { describeSolutionPackage, assertSolutionArtifacts } = await import(
  pathToFileURL(resolve(root, "packages/solution-sdk/dist/index.js")).href
);

const targets = process.argv.slice(2);
if (targets.length === 0) {
  process.stderr.write(
    "Usage: node scripts/solution-verify.mjs <package-dir> [more-dirs...]\n",
  );
  process.exit(2);
}

let failed = false;
for (const target of targets) {
  const dir = resolve(target);
  try {
    const readJson = async (name) =>
      JSON.parse(await readFile(resolve(dir, name), "utf8"));
    const descriptor = describeSolutionPackage({
      manifest: await readJson("solution.manifest.json"),
      lock: await readJson("solution.lock.json"),
      signature: await readJson("signature.json"),
    });
    const verified = await assertSolutionArtifacts(descriptor, dir);
    process.stdout.write(
      `PASS ${dir}: ${descriptor.manifest.metadata.id}@${descriptor.manifest.metadata.version}, ${verified.length} artifact(s) verified\n`,
    );
  } catch (error) {
    failed = true;
    process.stderr.write(
      `FAIL ${dir}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

if (failed) {
  process.stderr.write("\nsolution:verify FAILED\n");
  process.exit(1);
}
process.stdout.write("\nsolution:verify PASS\n");

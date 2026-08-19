import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(projectDir, script, label = `${projectDir} ${script}`) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync("pnpm", ["--dir", resolve(root, projectDir), ...script], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.stderr.write(`\nFAILED: ${label} (exit ${String(result.status)})\n`);
    process.exit(result.status ?? 1);
  }
}

run("packages/solution-sdk", ["build"], "build @weflow/solution-sdk");

const { validateSolutionManifest, validateSolutionLock } = await import(
  pathToFileURL(resolve(root, "packages/solution-sdk/dist/index.js")).href
);

function assertValid(result, label) {
  if (result.ok) {
    process.stdout.write(`PASS ${label}\n`);
    return;
  }
  process.stderr.write(`FAIL ${label}\n`);
  for (const issue of result.issues) {
    process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
  }
  process.exit(1);
}

const solutions = ["customer-support", "knowledge", "memory"];

for (const name of solutions) {
  const solutionDir = resolve(root, "solutions", name);
  const manifest = JSON.parse(
    await readFile(resolve(solutionDir, "solution.manifest.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(resolve(solutionDir, "solution.lock.json"), "utf8"),
  );

  assertValid(
    validateSolutionManifest(manifest),
    `${name}: solution.manifest.json validation`,
  );
  assertValid(validateSolutionLock(lock), `${name}: solution.lock.json validation`);

  if (lock.solutionId !== manifest.metadata.id) {
    process.stderr.write(
      `FAIL ${name}: lock.solutionId ${lock.solutionId} does not match manifest id ${manifest.metadata.id}\n`,
    );
    process.exit(1);
  }
  if (lock.solutionVersion !== manifest.metadata.version) {
    process.stderr.write(
      `FAIL ${name}: lock.solutionVersion ${lock.solutionVersion} does not match manifest version ${manifest.metadata.version}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`PASS ${name}: solution manifest/lock consistency\n`);

  for (const artifact of lock.artifacts ?? []) {
    const registry = artifact.registry ?? "file";
    if (registry !== "file") {
      process.stderr.write(
        `FAIL ${name}: unsupported artifact registry ${registry} for ${artifact.id}\n`,
      );
      process.exit(1);
    }
    const candidate = resolve(solutionDir, artifact.ref);
    const rel = relative(solutionDir, candidate);
    if (
      isAbsolute(rel) ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      rel.split(sep).includes("..")
    ) {
      process.stderr.write(
        `FAIL ${name}: artifact path escapes solution dir: ${artifact.ref}\n`,
      );
      process.exit(1);
    }
    const content = await readFile(candidate);
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (digest !== artifact.digest) {
      process.stderr.write(
        `FAIL ${name}: artifact digest mismatch for ${artifact.id}: expected ${artifact.digest}, got ${digest}\n`,
      );
      process.exit(1);
    }
  }
  process.stdout.write(`PASS ${name}: solution artifact digests\n`);

  // 官方基础 Solution 使用 dev-unsigned 占位签名，仓库内不随附公钥，
  // 因此这里跳过 Ed25519 签名验证（与仓库现状一致）。
  process.stdout.write(
    `SKIP ${name}: signature verification (dev-unsigned placeholder, no key in repo)\n`,
  );
}

process.stdout.write("\nsolution:verify PASS\n");

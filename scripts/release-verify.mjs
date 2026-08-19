import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(projectDir, script, label) {
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

run("packages/contracts", ["build"], "build contracts");
run("packages/contracts", ["test"], "test contracts");
run("packages/solution-sdk", ["build"], "build solution-sdk");
run("packages/solution-sdk", ["test"], "test solution-sdk");
run("packages/plugin-sdk", ["build"], "build plugin-sdk");
run("packages/plugin-sdk", ["test"], "test plugin-sdk");
run("packages/admin-sdk", ["build"], "build admin-sdk");
run("packages/admin-sdk", ["test"], "test admin-sdk");
run("packages/ui", ["build"], "build ui");
run("packages/ui", ["test"], "test ui");
run("apps/solution-runner", ["build"], "build solution-runner");
run("tooling/weflowctl", ["build"], "build weflowctl");

const skippedDirs = new Set([
  ".git",
  ".turbo",
  ".cache",
  ".next",
  ".vite",
  "node_modules",
  "coverage",
  "dist",
  "dist-test",
  "build",
  "out",
]);

async function collectSecretFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirs.has(entry.name)) {
        await collectSecretFiles(full);
      }
      continue;
    }
    const relative = full.slice(root.length + 1).replaceAll("\\", "/");
    const base = entry.name.toLowerCase();
    const isDotEnv =
      base === ".env" ||
      (/^\.env\..+$/.test(base) && !/^\.env\.(example|sample)$/.test(base));
    const isSensitiveKeyFile =
      /(^|[._-])(secret|credential|private)[^.]*\.(pem|key|p12|pfx|jks|keystore|asc|gpg|ppk|p8|der)$/.test(
        base,
      );
    if (isDotEnv || isSensitiveKeyFile) {
      secretFiles.push(relative);
    }
  }
}
await collectSecretFiles(root);
if (secretFiles.length > 0) {
  process.stderr.write(`FAIL potential secret files found: ${secretFiles.join(", ")}\n`);
  process.exit(1);
}

const migration = await readFile(
  resolve(root, "core/migrations/0050_seed_platform_execution_profile.sql"),
  "utf8",
);
const migrationSql = migration.replace(/--[^\n]*/g, "");
if (
  migrationSql.includes("INSERT INTO") ||
  migrationSql.includes("platform-default")
) {
  process.stderr.write("FAIL platform-default production seed still present\n");
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      checks: {
        sdkBuildAndTest: true,
        solutionRunnerBuild: true,
        noSecretInRepo: true,
        noPlatformDefaultSeed: true,
      },
    },
    null,
    2,
  ),
);

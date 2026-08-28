import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isCi = process.argv.includes("--ci");
if (isCi && !process.env.TEST_DATABASE_URL) {
  process.stderr.write(
    "FAIL platform:verify:ci requires TEST_DATABASE_URL to be set\n",
  );
  process.exit(1);
}
if (!isCi && !process.env.TEST_DATABASE_URL) {
  process.stdout.write(
    "WARN TEST_DATABASE_URL is not set; Core integration tests will be skipped\n",
  );
}

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

const steps = [
  // SDK packages must be built before apps that consume them.
  ["packages/contracts", ["build"]],
  ["packages/contracts", ["test"]],
  ["packages/plugin-sdk", ["build"]],
  ["packages/plugin-sdk", ["test"]],
  ["packages/admin-sdk", ["build"]],
  ["packages/admin-sdk", ["test"]],
  ["packages/solution-sdk", ["build"]],
  ["packages/solution-sdk", ["test"]],
  ["packages/ui", ["build"]],
  ["packages/ui", ["test"]],
  // Platform apps.
  ["core", ["check"]],
  ["apps/console", ["check"]],
  ["tooling/weflowctl", ["typecheck"]],
  ["tooling/weflowctl", ["build"]],
  ["apps/solution-runner", ["typecheck"]],
  ["apps/solution-runner", ["build"]],
];

for (const [dir, script] of steps) {
  run(dir, script);
}

// Channel 协议跨语言对齐：host 侧 channel_protocol.py 必须与 @weflow/contracts 权威一致
process.stdout.write("\n=== channel protocol sync (--check) ===\n");
{
  const result = spawnSync(
    process.execPath,
    ["core/node_modules/tsx/dist/cli.mjs", "scripts/sync-channel-protocol.ts", "--check"],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.stderr.write("\nFAILED: channel protocol is out of sync\n");
    process.exit(result.status ?? 1);
  }
}

process.stdout.write("\nplatform:verify PASS\n");

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SolutionRunnerClient } from "./client.js";
import { runOnce, type RunnerOptions } from "./runner.js";

const baseUrl = process.env.CORE_API_URL;
const token = process.env.RUNNER_TOKEN;
const runnerId = process.env.RUNNER_ID ?? "runner";
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? "5000");

if (!baseUrl || !token) {
  console.error(
    "CORE_API_URL and RUNNER_TOKEN environment variables are required",
  );
  process.exit(1);
}

const publicKeyFile = process.env.SOLUTION_PUBLIC_KEY_FILE;
const publicKeyPem = publicKeyFile
  ? readFileSync(resolve(publicKeyFile), "utf8")
  : process.env.SOLUTION_PUBLIC_KEY;
const allowUnsigned = process.env.SOLUTION_DEV_UNSIGNED === "1";
if (!publicKeyPem && !allowUnsigned) {
  console.error(
    "SOLUTION_PUBLIC_KEY_FILE or SOLUTION_PUBLIC_KEY is required (or set SOLUTION_DEV_UNSIGNED=1 in development)",
  );
  process.exit(1);
}
if (!publicKeyPem && process.env.NODE_ENV === "production") {
  console.error(
    "production Solution Runner requires SOLUTION_PUBLIC_KEY_FILE or SOLUTION_PUBLIC_KEY",
  );
  process.exit(1);
}

const runnerOptions: RunnerOptions = {
  ...(publicKeyPem === undefined ? {} : { publicKeyPem }),
  allowUnsigned,
  ...(process.env.SOLUTION_STAGING_ROOT === undefined
    ? {}
    : { stagingRoot: process.env.SOLUTION_STAGING_ROOT }),
};

const client = new SolutionRunnerClient({ baseUrl, token, runnerId });

let running = false;
let stopped = false;

async function poll(): Promise<void> {
  if (running || stopped) return;
  running = true;
  try {
    const processed = await runOnce(client, console, runnerOptions);
    if (processed > 0) {
      console.info({ processed }, "solution operations processed");
    }
  } catch (error) {
    console.error({ error }, "solution runner poll failed");
  } finally {
    running = false;
  }
}

await poll();
const timer = setInterval(() => {
  void poll();
}, pollIntervalMs);

function shutdown(): void {
  stopped = true;
  clearInterval(timer);
  console.info("solution runner stopped");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

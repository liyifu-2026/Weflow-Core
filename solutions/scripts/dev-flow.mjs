/**
 * Dev flow: one command for the complete plugin development → gate pipeline.
 *
 *   node scripts/dev-flow.mjs [--solution customer-support]
 *                            [--skip-quick] [--skip-install] [--expect reply]
 *
 * Steps (each fails the whole flow on error):
 *   0. environment check (platform api/worker health, DB/Redis reachable)
 *   1. build plugins (+ vendor SDKs)
 *   2. pack the Solution (real artifact tgz + lock digests + dev signature)
 *   3. verify the Solution Pack (SDK validation + digest + manifestDigest)
 *   4. quick gate: e2e-gate without profile (worker injects plugin dists via
 *      SKILL_PLUGIN_PATH / STRATEGY_PLUGIN_PATH)
 *   5. install: login (ADMIN_USER/ADMIN_PASSWORD) → zip the pack → import
 *      via the platform API → poll the operation to succeeded
 *   6. formal gate: e2e-gate --profile <solutionId/profileId> (turn bound to
 *      the installed Execution Profile)
 *
 * Env:
 *   PLATFORM_URL    default http://127.0.0.1:3100
 *   ADMIN_USER      platform admin username (required unless --skip-install)
 *   ADMIN_PASSWORD  platform admin password
 *   DATABASE_URL    default postgresql://weflow:weflow@127.0.0.1:5432/weflow
 *   REDIS_URL       default redis://127.0.0.1:6379
 *
 * Exit codes: 0 = full pipeline passed, 1 = any step failed.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const solutionName = args.solution ?? "customer-support";
const expect = args.expect ?? "reply";
const skipQuick = args["skip-quick"] === true;
const skipInstall = args["skip-install"] === true;
const solutionDir = resolve(root, "solutions", solutionName);
const platformUrl = (process.env.PLATFORM_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const adminUser = process.env.ADMIN_USER;
const adminPassword = process.env.ADMIN_PASSWORD;

function step(label, fn) {
  process.stdout.write(`\n=== ${label} ===\n`);
  return fn();
}
function run(cmd, argsList, options = {}) {
  return execFileSync(cmd, argsList, {
    stdio: "inherit",
    cwd: options.cwd ?? root,
    shell: process.platform === "win32",
    env: { ...process.env, ...options.env },
  });
}
function fail(message) {
  console.error(`\n[dev-flow] FAIL: ${message}`);
  process.exit(1);
}
function pass(message) {
  console.log(`[dev-flow] PASS: ${message}`);
}

async function waitFor(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return true;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function platformRequest(path, init = {}, token) {
  const response = await fetch(`${platformUrl}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined || init.body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

async function login() {
  if (!adminUser || !adminPassword) {
    fail("ADMIN_USER / ADMIN_PASSWORD are required for the install step (or use --skip-install)");
  }
  const response = await fetch(`${platformUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: adminUser, password: adminPassword }),
  });
  if (!response.ok) {
    fail(`login failed (${response.status})`);
  }
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = cookie.match(/weflow_session=([^;]+)/);
  if (!match) fail("login response did not include a session cookie");
  return match[1];
}

async function installPack(token) {
  const manifest = JSON.parse(
    readFileSync(resolve(solutionDir, "solution.manifest.json"), "utf8"),
  );
  const solutionId = manifest.metadata.id;
  // Build the pack zip: manifest/lock/signature + artifacts + backend.
  const tmpDir = resolve(root, ".tmp", `pack-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const zipPath = resolve(root, ".tmp", `${solutionName}.zip`);
  for (const entry of ["solution.manifest.json", "solution.lock.json", "signature.json", "artifacts", "backend"]) {
    const src = resolve(solutionDir, entry);
    if (existsSync(src)) {
      cpSync(src, resolve(tmpDir, entry), { recursive: true });
    }
  }
  rmSync(zipPath, { force: true });
  // tar emits "./" prefixed entries which AdmZip on the platform does not
  // match; Compress-Archive writes plain relative entries.
  const compressScript =
    `Compress-Archive -Path '${tmpDir.replaceAll("'", "''")}\\*' -DestinationPath '${zipPath.replaceAll("'", "''")}' -Force`;
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", compressScript],
    { stdio: "ignore" },
  );
  rmSync(tmpDir, { recursive: true, force: true });

  const form = new FormData();
  form.append("file", new Blob([readFileSync(zipPath)]), `${solutionName}.zip`);
  const imported = await platformRequest("/api/v1/admin/solutions/import", {
    method: "POST",
    body: form,
  }, token);
  const operationId = imported.operation?.operationId;
  if (!operationId) fail("import did not return an operationId");
  pass(`import created operation ${operationId} (${imported.operation.type})`);

  // Poll until terminal.
  const deadline = Date.now() + 120_000;
  let state = "queued";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const data = await platformRequest(
      `/api/v1/admin/solution-operations/${encodeURIComponent(operationId)}`,
      {},
      token,
    );
    state = data.operation?.state ?? "unknown";
    if (["succeeded", "failed", "superseded"].includes(state)) break;
  }
  if (state !== "succeeded") fail(`install operation ended ${state}`);
  pass(`solution ${solutionId} installed (operation succeeded)`);

  const profileId = `${solutionId}/${manifest.executionProfiles?.[0]?.id ?? "default"}`;
  return profileId;
}

// 0. Environment check.
await step("environment check", async () => {
  if (!(await waitFor(`${platformUrl}/health/live`))) fail(`platform api unreachable at ${platformUrl}`);
  if (!(await waitFor(`http://127.0.0.1:3101/health/live`))) fail("agent worker unreachable at 3101");
  pass("platform api + agent worker healthy");
});

// 1. Build.
step("build", () => {
  run("pnpm", ["build"]);
  pass("build");
});

// 2. Pack.
step("pack", () => {
  run("node", ["scripts/pack-solution.mjs", `solutions/${solutionName}`]);
  pass("pack");
});

// 3. Verify.
step("verify", () => {
  run("node", ["scripts/verify-solution.mjs", `solutions/${solutionName}`]);
  pass("verify");
});

// 4. Quick gate (worker-injected plugins, no profile).
if (!skipQuick) {
  await step("quick gate (injected plugins)", async () => {
    run("node", ["scripts/e2e-gate.mjs", "--expect", expect], {
      env: {
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://weflow:weflow@127.0.0.1:5432/weflow",
        REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      },
    });
    pass("quick gate");
  });
}

// 5. Install via platform API.
let profileId;
if (!skipInstall) {
  await step("install", async () => {
    const token = await login();
    profileId = await installPack(token);
    pass(`profile ${profileId} active`);
  });
}

// 6. Formal gate bound to the installed Execution Profile.
if (profileId) {
  await step("formal gate (profile-bound)", async () => {
    run("node", ["scripts/e2e-gate.mjs", "--expect", expect, "--profile", profileId], {
      env: {
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://weflow:weflow@127.0.0.1:5432/weflow",
        REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      },
    });
    pass("formal gate");
  });
}

console.log(`\n[dev-flow] ALL PASS (solution=${solutionName}, expect=${expect})`);
process.exit(0);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith("--")) {
      out[key] = value;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

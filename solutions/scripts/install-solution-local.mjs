/**
 * 手动安装/激活本地构建的 Solution 到 Solution Store（无需 zip 导入路由）。
 *
 * 用法：node scripts/install-solution-local.mjs <solution-dir> <platform-url> <user> <pass>
 *
 * 流程：登录 → POST /api/v1/admin/solution-operations（install，带 manifest/lock/signature）
 *       → 复制 solution 目录到 store 新版本目录（与 installSolutionToStore 同布局）
 *       → POST activate → 轮询确认。
 *
 * 说明：平台当前没有 zip import 路由（Console 的 /solutions/import 端点在
 * router 契约外），本地开发安装走 store 目录 + activate。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const [solutionDirArg, platformUrlArg, username, password] = process.argv.slice(2);
if (!solutionDirArg || !username || !password) {
  console.error(
    "usage: node install-solution-local.mjs <solution-dir> <platform-url> <user> <pass>",
  );
  process.exit(1);
}
const platformUrl = platformUrlArg.replace(/\/$/, "");
const solutionDir = resolve(solutionDirArg);
const manifest = JSON.parse(
  readFileSync(join(solutionDir, "solution.manifest.json"), "utf8"),
);
const lock = JSON.parse(readFileSync(join(solutionDir, "solution.lock.json"), "utf8"));
const signature = JSON.parse(readFileSync(join(solutionDir, "signature.json"), "utf8"));
const solutionId = manifest.metadata.id;
const version = manifest.metadata.version;

// 1. login
const loginResp = await fetch(`${platformUrl}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
});
if (!loginResp.ok) {
  console.error(`login failed: ${loginResp.status}`);
  process.exit(1);
}
const cookie = (loginResp.headers.get("set-cookie") ?? "")
  .split(";")[0]
  .split("=")[1];
if (!cookie) {
  console.error("login ok but no session cookie");
  process.exit(1);
}
console.log(`login ok (installing ${solutionId}@${version})`);

async function api(path, init = {}) {
  const resp = await fetch(`${platformUrl}${path}`, {
    ...init,
    headers: {
      cookie: `weflow_session=${cookie}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, text, json: text ? JSON.parse(text) : {} };
}

// 2. install operation（带 payload，供 Console 审计；store 落盘走本地复制）
const idempotencyKey = `local-install-${version}-${randomUUID()}`;
const installOp = await api("/api/v1/admin/solution-operations", {
  method: "POST",
  body: JSON.stringify({
    solutionId,
    type: "install",
    idempotencyKey,
    solutionVersion: version,
    manifest,
    lock,
    signature,
  }),
});
if (!installOp.ok) {
  console.error(`install operation failed ${installOp.status}: ${installOp.text.slice(0, 300)}`);
  process.exit(1);
}
console.log(`install operation created: ${installOp.json.operation?.operationId}`);

// 3. 落盘到 store（与 installSolutionToStore 相同布局：verbatim 复制，带 lock+signature）
const os = await import("node:os");
const storeRoot = process.env.WEFLOW_SOLUTION_STORE
  ? resolve(process.env.WEFLOW_SOLUTION_STORE)
  : join(os.homedir(), ".weflow", "solutions");
const versionDir = join(storeRoot, solutionId, version);
rmSync(versionDir, { recursive: true, force: true });
mkdirSync(join(storeRoot, solutionId), { recursive: true });
cpSync(solutionDir, versionDir, { recursive: true });
console.log(`copied to store: ${versionDir}`);

// 4. activate operation
const activateOp = await api("/api/v1/admin/solution-operations", {
  method: "POST",
  body: JSON.stringify({
    solutionId,
    type: "activate",
    idempotencyKey: `local-activate-${version}-${randomUUID()}`,
    solutionVersion: version,
  }),
});
if (!activateOp.ok) {
  console.error(
    `activate operation failed ${activateOp.status}: ${activateOp.text.slice(0, 300)}`,
  );
  process.exit(1);
}
const activateState = activateOp.json.operation?.state;
console.log(`activate operation: ${activateState}`);

// 5. 验证 active 指向新版本
const activeLink = join(storeRoot, solutionId, "active");
const activeManifest = JSON.parse(
  readFileSync(join(activeLink, "solution.manifest.json"), "utf8"),
);
console.log(`active version now: ${activeManifest.metadata.version}`);
process.exit(activeManifest.metadata.version === version ? 0 : 1);

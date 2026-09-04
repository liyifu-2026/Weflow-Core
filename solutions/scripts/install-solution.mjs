/**
 * 手动安装 Solution Pack（PowerShell 5.1 无 multipart 支持，用 Node 上传）。
 *
 * 用法：node scripts/install-solution.mjs <zip-path> <username> <password> [platform-url]
 *
 * 步骤：登录（cookie）→ multipart 上传 zip → 轮询 operation 至 succeeded。
 */
import { readFileSync } from "node:fs";

const [zipPath, username, password, platformUrlArg] = process.argv.slice(2);
if (!zipPath || !username || !password) {
  console.error("usage: node install-solution.mjs <zip> <user> <pass> [url]");
  process.exit(1);
}
const platformUrl = (platformUrlArg ?? "http://127.0.0.1:3100").replace(/\/$/, "");

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
console.log("login ok");

const zip = readFileSync(zipPath);
const boundary = `----weflow${Date.now()}`;
const parts = [];
parts.push(
  Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="customer-support.zip"\r\nContent-Type: application/zip\r\n\r\n`,
  ),
);
parts.push(zip);
parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
const body = Buffer.concat(parts);

const importResp = await fetch(`${platformUrl}/api/v1/admin/solutions/import`, {
  method: "POST",
  headers: {
    cookie: `weflow_session=${cookie}`,
    "content-type": `multipart/form-data; boundary=${boundary}`,
  },
  body,
});
const importText = await importResp.text();
if (!importResp.ok) {
  console.error(`import failed ${importResp.status}: ${importText.slice(0, 300)}`);
  process.exit(1);
}
const imported = JSON.parse(importText);
const operationId = imported.operation?.operationId;
if (!operationId) {
  console.error("import ok but no operationId");
  process.exit(1);
}
console.log(`import created operation ${operationId}`);

const deadline = Date.now() + 180_000;
let state = "queued";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const poll = await fetch(
    `${platformUrl}/api/v1/admin/solution-operations/${encodeURIComponent(operationId)}`,
    { headers: { cookie: `weflow_session=${cookie}` } },
  );
  const data = await poll.json();
  state = data.operation?.state ?? "unknown";
  if (["succeeded", "failed", "superseded"].includes(state)) break;
  process.stdout.write(`  ${state}\n`);
}
console.log(`operation ended: ${state}`);
process.exit(state === "succeeded" ? 0 : 1);

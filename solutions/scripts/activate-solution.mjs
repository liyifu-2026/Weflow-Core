/**
 * 激活指定 Solution 版本（Node，绕过 PowerShell 5.1 cookie 处理问题）。
 * 用法：node scripts/activate-solution.mjs <solutionId> <version> <user> <pass> [url]
 */
const [solutionId, version, username, password, platformUrlArg] = process.argv.slice(2);
if (!solutionId || !version || !username || !password) {
  console.error("usage: node activate-solution.mjs <id> <ver> <user> <pass> [url]");
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
  .split("=")
  .slice(1)
  .join("=");
if (!cookie) {
  console.error("no session cookie");
  process.exit(1);
}

const resp = await fetch(`${platformUrl}/api/v1/admin/solution-operations`, {
  method: "POST",
  headers: {
    cookie: `weflow_session=${cookie}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    solutionId,
    type: "activate",
    idempotencyKey: `cli-activate-${version}-${Date.now()}`,
    solutionVersion: version,
  }),
});
const text = await resp.text();
if (!resp.ok) {
  console.error(`activate failed ${resp.status}: ${text.slice(0, 300)}`);
  process.exit(1);
}
const data = JSON.parse(text);
console.log(`activate operation: ${data.operation?.state ?? "unknown"}`);

// 验证：读 extensions 投影确认版本
const ext = await fetch(`${platformUrl}/api/v1/admin/solutions/extensions`, {
  headers: { cookie: `weflow_session=${cookie}` },
});
const extData = await ext.json();
const group = (extData.solutions ?? []).find((s) => s.solutionId === solutionId);
console.log(`active projection version: ${group?.version ?? "not-found"}`);
process.exit(group?.version === version ? 0 : 1);

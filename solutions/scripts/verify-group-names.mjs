/**
 * 验证群聊显示名兜底在 API 生效。
 * 用法：node scripts/verify-group-names.mjs <user> <pass> [url]
 */
const [username, password, platformUrlArg] = process.argv.slice(2);
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
const cookie = (loginResp.headers.get("set-cookie") ?? "").split(";")[0];

const contacts = await fetch(`${platformUrl}/api/v1/contacts?limit=100`, {
  headers: { cookie },
}).then((r) => r.json());
console.log("=== contact list (groups) ===");
for (const c of contacts.contacts ?? []) {
  if (c.contactId.includes("@chatroom")) {
    console.log(" ", c.contactId.slice(-34), "->", c.channelDisplayName);
  }
}

const convs = await fetch(
  `${platformUrl}/api/v1/conversations?scope=all&limit=50`,
  { headers: { cookie } },
).then((r) => r.json());
console.log("=== conversation list (groups) ===");
for (const c of convs.conversations ?? []) {
  if (c.chatType === "group") {
    console.log(
      " ",
      String(c.conversationId).slice(-34),
      "chatType:",
      c.chatType,
      "| name:",
      c.contact?.channelDisplayName,
    );
  }
}

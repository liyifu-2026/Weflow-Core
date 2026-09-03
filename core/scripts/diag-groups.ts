/**
 * 列出 Core DB 中所有群聊联系人（@chatroom）+ 对比 channel-host 侧群列表。
 * 用法：node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/diag-groups.ts
 */
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const db = await client.query(
  "SELECT contact_id, channel_display_name, channel_nickname, agent_enabled, created_at FROM conversation.contact_profiles WHERE contact_id LIKE '%@chatroom%' ORDER BY created_at",
);
console.log("=== chatroom contacts in Core DB:", db.rows.length, "===");
for (const r of db.rows) {
  console.log(
    " ",
    String(r.contact_id).slice(0, 56),
    "|",
    r.channel_display_name ?? r.channel_nickname ?? "(无名)",
    "| agent:",
    r.agent_enabled,
    "| created:",
    r.created_at?.toISOString?.().slice(0, 10),
  );
}

await client.end();

/**
 * 快速诊断：最近 2 小时的入站消息和 Agent Turn 状态。
 * 用法：node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/diag-turns.ts
 */
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const turns = await client.query(
  "SELECT turn_id, conversation_id, status, created_at FROM agent.turns WHERE created_at > now() - interval '3 hours' ORDER BY created_at DESC LIMIT 8",
);
console.log("=== recent agent turns (3h):", turns.rows.length, "===");
for (const t of turns.rows) {
  console.log(" ", String(t.turn_id).slice(0, 44), t.status, t.created_at);
}

const msgs = await client.query(
  "SELECT conversation_id, direction, actor_type, occurred_at, left(text, 36) as preview FROM conversation.messages WHERE occurred_at > now() - interval '3 hours' ORDER BY occurred_at DESC LIMIT 10",
);
console.log("=== recent messages (3h):", msgs.rows.length, "===");
for (const m of msgs.rows) {
  console.log(
    " ",
    String(m.conversation_id).slice(0, 42),
    m.direction,
    m.actor_type,
    m.occurred_at,
    JSON.stringify(m.preview),
  );
}

const contact = await client.query(
  "SELECT contact_id, agent_enabled, blocked, channel_display_name FROM conversation.contact_profiles WHERE contact_id ILIKE '%457407502%' LIMIT 3",
);
console.log("=== contact state ===");
for (const r of contact.rows) {
  console.log(" ", String(r.contact_id).slice(0, 46), "agentEnabled:", r.agent_enabled, "blocked:", r.blocked, r.channel_display_name);
}
const runtime = await client.query(
  "SELECT key, value FROM operations.runtime_settings WHERE key IN ('agentEnabled','autoSendEnabled')",
);
console.log("=== runtime switches ===");
for (const r of runtime.rows) {
  console.log(" ", r.key, "=", r.value);
}

await client.end();

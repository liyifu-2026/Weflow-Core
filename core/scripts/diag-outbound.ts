/**
 * 出站发送链路诊断：pending/发送中消息、send operations 状态、卡点定位。
 * 用法：node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/diag-outbound.ts
 */
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// 1. 出站消息按 send_state 分布（最近 3 小时）
const states = await client.query(
  "SELECT send_state, count(*) as n FROM conversation.messages WHERE direction = 'outbound' AND occurred_at > now() - interval '3 hours' GROUP BY send_state ORDER BY n DESC",
);
console.log("=== outbound send_state (3h) ===");
for (const r of states.rows) {
  console.log(" ", r.send_state ?? "(null)", "->", r.n);
}

// 2. 卡住的消息明细（pending/submitting/unknown）
const stuck = await client.query(
  "SELECT message_id, conversation_id, send_state, send_error, send_operation_id, send_updated_at, left(text,24) as preview FROM conversation.messages WHERE direction='outbound' AND send_state IN ('pending','submitting','unknown') AND occurred_at > now() - interval '6 hours' ORDER BY occurred_at DESC LIMIT 12",
);
console.log("=== stuck outbound messages ===");
for (const r of stuck.rows) {
  console.log(
    " ",
    String(r.message_id).slice(0, 44),
    r.send_state,
    r.send_error ?? "",
    r.send_updated_at,
    JSON.stringify(r.preview),
  );
}

// 3. send operations 状态分布
const ops = await client.query(
  "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name ILIKE '%operation%' ORDER BY 1,2",
);
console.log("=== operation tables ===");
for (const r of ops.rows) {
  console.log(" ", r.table_schema, r.table_name);
}

// 4. agent turns 最近状态（是否有回不了）
const turns = await client.query(
  "SELECT status, count(*) as n FROM agent.turns WHERE created_at > now() - interval '3 hours' GROUP BY status",
);
console.log("=== agent turns (3h) ===");
for (const r of turns.rows) {
  console.log(" ", r.status, "->", r.n);
}

await client.end();

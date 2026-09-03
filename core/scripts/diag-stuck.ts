/**
 * 出站卡死消息深查：两条 pending 手动消息是谁的、哪个会话、出站轮询为何没消费。
 * 用法：node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/diag-stuck.ts
 */
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const stuck = await client.query(
  "SELECT message_id, conversation_id, send_state, actor_type, created_at, occurred_at, send_updated_at FROM conversation.messages WHERE send_state IN ('pending','submitting','unknown') ORDER BY occurred_at DESC LIMIT 10",
);
console.log("=== all stuck outbound messages ===");
for (const r of stuck.rows) {
  console.log(
    " ",
    String(r.message_id).slice(0, 52),
    r.send_state,
    r.actor_type,
    "created:",
    r.created_at,
    "conv:",
    String(r.conversation_id).slice(0, 46),
  );
}

// 这些会话的 handoff 状态（人工接管中不影响人工消息发送，但要确认）
const convIds = stuck.rows.map((r) => r.conversation_id);
if (convIds.length) {
  const handoff = await client.query(
    "SELECT conversation_id, status, agent_paused, assigned_user_id FROM handoff.states WHERE conversation_id = ANY($1::varchar[])",
    { rows: convIds } as never,
  );
  console.log("=== handoff states for stuck conversations ===");
  for (const h of handoff.rows) {
    console.log(
      " ",
      String(h.conversation_id).slice(0, 46),
      h.status,
      "paused:",
      h.agent_paused,
    );
  }
}

// 出站轮询：谁在消费 pending（process-outbound 跑在 core-api 进程）
// 检查 outbound poller 是否活着：看是否有 operation_id 被分配
const withOp = await client.query(
  "SELECT count(*) as n FROM conversation.messages WHERE send_operation_id IS NOT NULL AND send_state = 'pending'",
);
console.log("pending with operation_id:", withOp.rows[0].n);

const withOpList = await client.query(
  "SELECT message_id, send_operation_id, send_updated_at FROM conversation.messages WHERE send_operation_id IS NOT NULL AND send_state IN ('pending','unknown') ORDER BY send_updated_at DESC LIMIT 6",
);
for (const r of withOpList.rows) {
  console.log(
    " ",
    String(r.message_id).slice(0, 50),
    "op:",
    String(r.send_operation_id).slice(0, 30),
    r.send_updated_at,
  );
}

await client.end();

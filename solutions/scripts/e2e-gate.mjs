/**
 * E2E gate: run one Agent turn through a live Weflow platform instance.
 *
 * This is the "dev → platform" gate: the platform instance (usually
 * Weflow-Core's release/platform-core) must be running with the plugins from
 * THIS repo injected via SKILL_PLUGIN_PATH / STRATEGY_PLUGIN_PATH and a
 * configured MODEL_API_KEY. The script seeds one conversation + inbound
 * message + queued Agent Turn directly (bypassing the Channel Host), enqueues
 * the turn into Redis, waits for the worker, prints the outcome and cleans up.
 *
 * Usage:
 *   node scripts/e2e-gate.mjs [--message "…"] [--expect reply|handoff|any]
 *                             [--timeout 90] [--keep]
 *
 * Env: DATABASE_URL (default postgresql://weflow:weflow@127.0.0.1:5432/weflow)
 *      REDIS_URL    (default redis://127.0.0.1:6379)
 *
 * Exit codes: 0 = gate passed (completed + expected outcome),
 *             2 = completed but outcome differs from --expect,
 *             1 = failed/superseded/timeout/error.
 */
import { Client } from "pg";
import { Queue } from "bullmq";

const args = parseArgs(process.argv.slice(2));
const message =
  args.message ??
  "你好，我的设备型号是 X100，开不了机，屏幕上显示错误码 E500，该怎么办？";
const expect = args.expect ?? "reply";
const timeoutMs = (args.timeout ?? 90) * 1000;
const keep = args.keep ?? false;
/** Execution Profile id：安装 Solution 后由平台写入 agent.execution_profiles，
 *  传此参数可验证按 profile.strategyRef 精确选择 Execution Strategy。 */
const profileId = typeof args.profile === "string" ? args.profile : undefined;

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://weflow:weflow@127.0.0.1:5432/weflow";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const redisConnection = { host: "127.0.0.1", port: 6379 };
try {
  const parsed = new URL(redisUrl);
  redisConnection.host = parsed.hostname;
  redisConnection.port = Number(parsed.port || 6379);
} catch {
  // keep defaults
}

const suffix = `${Date.now()}`;
const contactId = `contact:channel:e2e-${suffix}`;
const conversationId = `channel:e2e-${suffix}`;
const messageId = `channel:e2e-${suffix}-msg1`;
const turnId = `turn:${messageId}`;
const traceId = `e2e-${suffix}`;

const client = new Client({ connectionString: databaseUrl });
await client.connect();

console.log(`[e2e-gate] message: ${message.slice(0, 80)}`);
console.log(`[e2e-gate] expect: ${expect}${profileId ? ` | profile: ${profileId}` : ""}`);

try {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO conversation.contact_profiles (contact_id, channel, channel_contact_id, agent_enabled)
     VALUES ($1, 'channel', $2, true) ON CONFLICT DO NOTHING`,
    [contactId, `e2e-${suffix}`],
  );
  await client.query(
    `INSERT INTO conversation.conversations (conversation_id, contact_id, channel, channel_conversation_id)
     VALUES ($1, $2, 'channel', $3) ON CONFLICT DO NOTHING`,
    [conversationId, contactId, `e2e-${suffix}`],
  );
  await client.query(
    `INSERT INTO conversation.messages (message_id, conversation_id, direction, actor_type, content_type,
       channel_type, text, is_self, processing_state, idempotency_key, trace_id, occurred_at)
     VALUES ($1, $2, 'inbound', 'channel_contact', 'text', 1, $3, false, 'received', $4, $5, now())`,
    [messageId, conversationId, message, `e2e-msg-${suffix}`, traceId],
  );
  await client.query(
    `INSERT INTO agent.turns (turn_id, trigger_message_id, conversation_id, status, execution_profile_id, trace_id)
     VALUES ($1, $2, $3, 'queued', $4, $5)`,
    profileId
      ? [turnId, messageId, conversationId, profileId, traceId]
      : [turnId, messageId, conversationId, null, traceId],
  );
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
}

const queue = new Queue("agent-turns", { connection: redisConnection });
await queue.add("agent-turn", { businessEntityId: turnId, traceId });
console.log(`[e2e-gate] enqueued turn ${turnId}`);

// Wait for a terminal turn status.
const terminal = ["completed", "failed", "superseded", "suppressed_policy", "suppressed_handoff"];
let status = null;
let errorCode = null;
const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const rows = await client.query(
    `SELECT status, error_code FROM agent.turns WHERE turn_id = $1`,
    [turnId],
  );
  status = rows.rows[0]?.status ?? null;
  errorCode = rows.rows[0]?.error_code ?? null;
  if (status && terminal.includes(status)) break;
}
if (!status || !terminal.includes(status)) {
  console.error(`[e2e-gate] TIMEOUT: turn status=${status ?? "missing"} error=${errorCode ?? "none"}`);
  await cleanup();
  process.exit(1);
}

const replies = await client.query(
  `SELECT text, reply_sequence, send_state FROM conversation.messages
   WHERE conversation_id = $1 AND direction = 'outbound' ORDER BY reply_sequence NULLS LAST`,
  [conversationId],
);
console.log(`\n=== TURN ${status} (error=${errorCode ?? "none"}) ===`);
console.log(`agent replies: ${replies.rows.length}`);
for (const row of replies.rows) {
  console.log(`---\n${row.text}`);
}
if (status !== "completed") {
  const events = await client.query(
    `SELECT event_type, reason_code FROM agent.turn_events WHERE turn_id = $1 ORDER BY created_at`,
    [turnId],
  );
  console.log(
    "turn events:",
    events.rows.map((r) => `${r.event_type}${r.reason_code ? `(${r.reason_code})` : ""}`).join(", "),
  );
}

// Gate verdict.
let exitCode = 0;
const hasReply = replies.rows.length > 0;
const outcome = status === "completed" ? "reply" : "handoff";
if (status === "failed" || status === "superseded") {
  exitCode = 1;
  console.error(`[e2e-gate] FAIL: turn ended ${status}`);
} else if (status === "completed" && !hasReply) {
  exitCode = 1;
  console.error(`[e2e-gate] FAIL: completed without any outbound message`);
} else if (expect !== "any" && outcome !== expect) {
  exitCode = 2;
  console.error(`[e2e-gate] FAIL: expected ${expect}, got ${outcome}`);
} else {
  console.log(`[e2e-gate] PASS: ${outcome}`);
}

await cleanup();
process.exit(exitCode);

async function cleanup() {
  if (keep) {
    console.log(`[e2e-gate] --keep: seeded rows left in DB (conversation ${conversationId})`);
    return;
  }
  // Foreign-key order: handoff/memory rows reference the conversation first.
  await client.query(`DELETE FROM handoff.states WHERE conversation_id = $1`, [conversationId]);
  await client.query(`DELETE FROM handoff.events WHERE conversation_id = $1`, [conversationId]);
  await client.query(`DELETE FROM handoff.cycles WHERE conversation_id = $1`, [conversationId]);
  await client.query(`DELETE FROM memory.capture_states WHERE conversation_id = $1`, [conversationId]);
  await client.query(`DELETE FROM agent.turn_events WHERE turn_id = $1`, [turnId]);
  await client.query(`DELETE FROM agent.turns WHERE turn_id = $1`, [turnId]);
  await client.query(`DELETE FROM conversation.messages WHERE conversation_id = $1`, [conversationId]);
  await client.query(`DELETE FROM conversation.conversations WHERE conversation_id = $1`, [conversationId]);
  await client.query(`DELETE FROM conversation.contact_profiles WHERE contact_id = $1`, [contactId]);
  await queue.close();
  await client.end();
  console.log("[e2e-gate] cleanup done");
}

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

/**
 * 并发会话压测脚本（摄取 + 分发层）
 *
 * 用途：模拟 N 个客户"同时"发消息，验证摄取管线在并发下：
 *   - 每个会话/消息/Agent Turn 均正确落库，不丢失、不串扰
 *   - coalesceQueuedAgentTurns 对 N 个独立会话各保留最新一个轮次（零 superseded）
 *
 * 用法：
 *   TEST_DATABASE_URL=postgresql://... LOAD_TEST_CONVERSATIONS=20 \
 *     pnpm tsx scripts/load-test-concurrency.ts
 *
 * 注意：
 *   - 必须使用一次性测试库（TEST_DATABASE_URL），脚本会写入并清理
 *     conversations/messages/agentTurns/contactProfiles/channelCursors；
 *     切勿指向生产或开发库。
 *   - 本脚本只压测「摄取 + 分发合并」层，不含 LLM 调用与 Channel Host 发送；
 *     后者需在真实环境用完整 worker 链路验证（见 docs/03-runtime-topology.md）。
 */
import { asc, eq, inArray } from "drizzle-orm";
import { createLogger } from "../infrastructure/observability/logger.js";
import { createPostgres } from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { coalesceQueuedAgentTurns } from "../infrastructure/redis/agent-turn-dispatcher.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";

const count = Number(process.env.LOAD_TEST_CONVERSATIONS ?? "20");
if (!Number.isInteger(count) || count < 1) {
  throw new Error("LOAD_TEST_CONVERSATIONS must be a positive integer");
}

const suffix = `${String(Date.now())}-${String(process.pid)}`;
const channelConversationIds = Array.from(
  { length: count },
  (_, index) => `load-${suffix}-${String(index)}`,
);
const conversationIds = channelConversationIds.map((id) => `channel:${id}`);
const contactIds = channelConversationIds.map((id) => `contact:channel:${id}`);

/** 构造一条入站文本事件（模拟单个客户发一条消息） */
function eventFor(index: number) {
  const conversationId = channelConversationIds[index];
  if (!conversationId) throw new Error("missing conversation id");
  return {
    cursor: String(1_000 + index),
    eventId: `load-${suffix}-${String(index)}`,
    conversationRef: conversationId,
    channelMessageId: `server-${suffix}-${String(index)}`,
    serverId: `19860763026721670${String(index)}`,
    localId: String(index),
    senderId: `wxid_load_${String(index)}`,
    type: 1,
    kind: "text",
    content: `并发压测消息 ${String(index)}`,
    occurredAt: new Date((1_700_000_000 + index) * 1000).toISOString(),
    observedAt: new Date((1_700_000_000 + index) * 1000).toISOString(),
    isSelf: false,
  };
}

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required — use a disposable test DB (this script writes and cleans up its own data)",
  );
}
const postgres = createPostgres(
  databaseUrl,
  createLogger({ logLevel: "silent" }, "load-test-concurrency"),
);

try {
  const startedAt = Date.now();
  // 模拟 N 个客户"同时"发消息：并发执行独立事务（真实并发压力）
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      ingestChannelEvents(
        postgres.db,
        [eventFor(index)],
        String(1_000 + index),
      ),
    ),
  );
  const ingestMs = Date.now() - startedAt;

  const conversations = await postgres.db
    .select({ conversationId: schema.conversations.conversationId })
    .from(schema.conversations)
    .where(inArray(schema.conversations.conversationId, conversationIds));
  const messages = await postgres.db
    .select({ messageId: schema.messages.messageId })
    .from(schema.messages)
    .where(inArray(schema.messages.conversationId, conversationIds));
  const turns = await postgres.db
    .select({
      turnId: schema.agentTurns.turnId,
      conversationId: schema.agentTurns.conversationId,
      createdAt: schema.agentTurns.createdAt,
    })
    .from(schema.agentTurns)
    .where(inArray(schema.agentTurns.conversationId, conversationIds))
    .orderBy(asc(schema.agentTurns.turnId));

  // 静默窗口外的分发合并：N 个独立会话应各保留 1 个 ready，零 superseded
  const coalesced = coalesceQueuedAgentTurns(
    turns.map((turn) => ({
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      traceId: "",
      createdAt: turn.createdAt,
    })),
    new Date(Date.now() + 60_000),
  );

  process.stdout.write(
    [
      `conversations=${String(conversations.length)}/${String(count)}`,
      `messages=${String(messages.length)}/${String(count)}`,
      `turns=${String(turns.length)}/${String(count)}`,
      `ready=${String(coalesced.ready.length)}`,
      `superseded=${String(coalesced.superseded.length)}`,
      `ingest_ms=${String(ingestMs)}`,
    ].join(" ") + "\n",
  );

  const ok =
    conversations.length === count &&
    messages.length === count &&
    turns.length === count &&
    coalesced.ready.length === count &&
    coalesced.superseded.length === 0;
  if (!ok) {
    process.exitCode = 1;
    process.stderr.write(
      "LOAD TEST FAILED: 每个并发客户应恰好产生 1 个会话/消息/轮次，且零 superseded\n",
    );
  }
} finally {
  // 清理压测数据，避免污染开发库
  await postgres.db
    .delete(schema.agentTurns)
    .where(inArray(schema.agentTurns.conversationId, conversationIds));
  await postgres.db
    .delete(schema.messages)
    .where(inArray(schema.messages.conversationId, conversationIds));
  await postgres.db
    .delete(schema.conversations)
    .where(inArray(schema.conversations.conversationId, conversationIds));
  await postgres.db
    .delete(schema.contactProfiles)
    .where(inArray(schema.contactProfiles.contactId, contactIds));
  await postgres.db
    .delete(schema.channelCursors)
    .where(eq(schema.channelCursors.source, "channel-host"));
  await postgres.close();
}

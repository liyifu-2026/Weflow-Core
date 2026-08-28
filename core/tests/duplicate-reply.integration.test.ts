import { and, eq, ne, notInArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import { AgentTurnExecutor } from "../modules/agent/application/agent-turn-executor.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationDatabaseUrl = databaseUrl ?? "";
const integration = databaseUrl ? describe : describe.skip;

function stubModelClient(replies: string[]) {
  let call = 0;
  return new OpenAiCompatibleClient({
    baseUrl: "https://model.invalid",
    apiKey: "test-only",
    model: "deepseek-v4-flash",
    timeoutMs: 1_000,
    fetch: (_input, init) => {
      if (typeof init?.body !== "string") {
        throw new Error("expected model request body");
      }
      const replyText = replies[call] ?? replies[replies.length - 1] ?? "";
      call += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply_text: replyText,
                    next_action: "reply",
                    requires_human: false,
                    risk_level: "low",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  });
}

integration("Agent duplicate reply guard", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const channelConversationId = `duplicate-guard-${suffix}`;
  const conversationId = `channel:${channelConversationId}`;
  const contactId = `contact:channel:${channelConversationId}`;

  const inboundEvent = (index: number, cursor: number) => ({
    cursor: String(cursor),
    eventId: `duplicate-guard-${suffix}-${String(index)}`,
    conversationRef: channelConversationId,
    channelMessageId: `server-${suffix}-${String(index)}`,
    serverId: `19860763026721669${String(index)}`,
    localId: String(index),
    senderId: "wxid_duplicate_guard",
    type: 1,
    kind: "text",
    content: `inbound message ${String(index)}`,
    occurredAt: new Date((1_700_000_000 + index) * 1000).toISOString(),
    observedAt: new Date((1_700_000_000 + index) * 1000).toISOString(),
    isSelf: false,
  });

  beforeAll(() => {
    postgres = createPostgres(
      integrationDatabaseUrl,
      createLogger({ logLevel: "silent" }, "integration-test"),
    );
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.conversationId, conversationId));
    await postgres.db
      .delete(schema.handoffEvents)
      .where(eq(schema.handoffEvents.conversationId, conversationId));
    await postgres.db
      .delete(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId));
    await postgres.db
      .delete(schema.handoffCycles)
      .where(eq(schema.handoffCycles.conversationId, conversationId));
    await postgres.db
      .delete(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(eq(schema.memoryCaptureStates.conversationId, conversationId));
    await postgres.db
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, contactId));
    await postgres.db
      .delete(schema.channelCursors)
      .where(eq(schema.channelCursors.source, "channel-host"));
    await postgres.close();
  });

  it("suppresses a reply identical to the previous agent reply", async () => {
    // 第一条客户消息 → 正常回复
    await ingestChannelEvents(postgres.db, [inboundEvent(1, 51)], "51");
    const firstTurn = (
      await postgres.db
        .select()
        .from(schema.agentTurns)
        .where(eq(schema.agentTurns.conversationId, conversationId))
    )[0];
    if (!firstTurn) throw new Error("expected a first agent turn");
    const model = stubModelClient([
      "好的，我明白了。",
      "好的，我明白了。",
      "好的，这次明白了。",
    ]);
    const executor = new AgentTurnExecutor(
      postgres.db,
      model,
      "deepseek-v4-flash",
    );
    await executor.execute({
      turnId: firstTurn.turnId,
      traceId: firstTurn.traceId,
    });

    const outboundAfterFirst = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.direction, "outbound"),
          eq(schema.messages.actorType, "agent"),
        ),
      );
    expect(outboundAfterFirst).toHaveLength(1);
    expect(outboundAfterFirst[0]).toMatchObject({
      actorType: "agent",
      direction: "outbound",
      text: "好的，我明白了。",
    });

    // 第二条客户消息 → 模型输出与上一条相同 → 拦截，不落库
    await ingestChannelEvents(postgres.db, [inboundEvent(2, 52)], "52");
    const secondTurn = (
      await postgres.db
        .select()
        .from(schema.agentTurns)
        .where(
          and(
            eq(schema.agentTurns.conversationId, conversationId),
            ne(schema.agentTurns.turnId, firstTurn.turnId),
          ),
        )
    )[0];
    if (!secondTurn) throw new Error("expected a second agent turn");
    await executor.execute({
      turnId: secondTurn.turnId,
      traceId: secondTurn.traceId,
    });

    const outboundAfterSecond = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.direction, "outbound"),
          eq(schema.messages.actorType, "agent"),
        ),
      );
    expect(outboundAfterSecond).toHaveLength(1);
    const secondTurnState = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, secondTurn.turnId));
    expect(secondTurnState[0]).toMatchObject({
      status: "suppressed_policy",
      errorCode: "duplicate_reply",
    });

    // 第三条客户消息 → 模型输出不同文本 → 正常回复
    await ingestChannelEvents(postgres.db, [inboundEvent(3, 53)], "53");
    const thirdTurn = (
      await postgres.db
        .select()
        .from(schema.agentTurns)
        .where(
          and(
            eq(schema.agentTurns.conversationId, conversationId),
            notInArray(schema.agentTurns.turnId, [
              firstTurn.turnId,
              secondTurn.turnId,
            ]),
          ),
        )
    )[0];
    if (!thirdTurn) throw new Error("expected a third agent turn");
    await executor.execute({
      turnId: thirdTurn.turnId,
      traceId: thirdTurn.traceId,
    });

    const outboundAfterThird = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.direction, "outbound"),
          eq(schema.messages.actorType, "agent"),
        ),
      );
    expect(outboundAfterThird).toHaveLength(2);
    expect(outboundAfterThird[1]).toMatchObject({
      actorType: "agent",
      direction: "outbound",
      text: "好的，这次明白了。",
    });
    const thirdTurnState = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, thirdTurn.turnId));
    expect(thirdTurnState[0]).toMatchObject({ status: "completed" });
  });
});

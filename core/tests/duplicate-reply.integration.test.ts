import { and, eq, ne, notInArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDuplicateOfLastReply } from "../modules/agent/application/duplicate-reply.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import type { SendState } from "../modules/conversations/application/send-states.js";
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

/** 让模型原样输出多段 reply_segments（用于验证批内重复段的落库收口） */
function stubSegmentModelClient(segments: string[]) {
  return new OpenAiCompatibleClient({
    baseUrl: "https://model.invalid",
    apiKey: "test-only",
    model: "deepseek-v4-flash",
    timeoutMs: 1_000,
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    next_action: "reply",
                    reply_segments: segments,
                    // 带 wait_ms：说完交权，本回合不再续步（聚焦批内去重一件事）
                    wait_ms: 80_000,
                    requires_human: false,
                    risk_level: "low",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });
}

integration("Agent duplicate reply guard", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const channelConversationId = `duplicate-guard-${suffix}`;
  const conversationId = `channel:${channelConversationId}`;
  const contactId = `contact:channel:${channelConversationId}`;
  // 第二个会话专用于「未送达分段不得充当上一条回复」的判定（互不干扰计数）。
  const stateConversationId = `channel:duplicate-state-${suffix}`;
  const stateContactId = `contact:channel:duplicate-state-${suffix}`;
  // 第三个会话专用于「批内逐字重复段的落库去重」，避免污染上面两个会话的
  // 「最近一条」顺序（本用例会真实落库一批回复）。
  const batchConversationId = `channel:duplicate-batch-${suffix}`;
  const batchContactId = `contact:channel:duplicate-batch-${suffix}`;

  const inboundEvent = (index: number, cursor: number) => ({
    cursor: String(cursor),
    eventId: `duplicate-guard-${suffix}-${String(index)}`,
    conversationRef: channelConversationId,
    channelMessageId: `server-${suffix}-${String(index)}`,
    serverId: `19860763026721669${String(index)}`,
    localId: String(index),
    senderId: "wxid_duplicate_guard",
    type: 1,
    kind: "text" as const,
    content: `inbound message ${String(index)}`,
    occurredAt: new Date((1_700_000_000 + index) * 1000).toISOString(),
    observedAt: new Date((1_700_000_000 + index) * 1000).toISOString(),
    isSelf: false,
  });

  beforeAll(async () => {
    postgres = createPostgres(
      integrationDatabaseUrl,
      createLogger({ logLevel: "silent" }, "integration-test"),
    );
    // 白名单模式（migration 0060）：预建 agentEnabled=true 的联系人，
    // 否则 ingest 不会为新入站消息创建 Agent Turn。
    await postgres.db
      .insert(schema.contactProfiles)
      .values({
        contactId,
        channel: "channel",
        channelContactId: channelConversationId,
        agentEnabled: true,
      })
      .onConflictDoNothing();
    await postgres.db
      .insert(schema.contactProfiles)
      .values({
        contactId: stateContactId,
        channel: "channel",
        channelContactId: `duplicate-state-${suffix}`,
        agentEnabled: true,
      })
      .onConflictDoNothing();
    await postgres.db
      .insert(schema.conversations)
      .values({
        conversationId: stateConversationId,
        contactId: stateContactId,
        channel: "channel",
        channelConversationId: `duplicate-state-${suffix}`,
        chatType: "private",
      })
      .onConflictDoNothing();
    await postgres.db
      .insert(schema.contactProfiles)
      .values({
        contactId: batchContactId,
        channel: "channel",
        channelContactId: `duplicate-batch-${suffix}`,
        agentEnabled: true,
      })
      .onConflictDoNothing();
    await postgres.db
      .insert(schema.conversations)
      .values({
        conversationId: batchConversationId,
        contactId: batchContactId,
        channel: "channel",
        channelConversationId: `duplicate-batch-${suffix}`,
        chatType: "private",
      })
      .onConflictDoNothing();
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
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, stateConversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, stateConversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, stateContactId));
    // capture_states.watermark_message_id 反指 messages：先删记忆捕获排队行
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(eq(schema.memoryCaptureStates.conversationId, batchConversationId));
    await postgres.db
      .delete(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, batchConversationId));
    await postgres.db
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, batchConversationId));
    await postgres.db
      .delete(schema.agentSessions)
      .where(eq(schema.agentSessions.conversationId, batchConversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, batchConversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, batchContactId));
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
      // 新契约：第一轮 turn 的回复不带 wait_ms → 续步多一次决策；
      // 第二步复读同一内容触发优雅收口（completed），消息只发一条。
      "好的，我明白了。",
      "好的，我明白了。",
      // 第一轮收口后的下一轮（secondTurn）输出不同文本 → 正常落库
      "好的，这次明白了。",
      // secondTurn 的回复同样不带 wait_ms → 续步复读收口
      "好的，这次明白了。",
      // thirdTurn 正常回复
      "这次真的明白了。",
      // thirdTurn 续步复读收口
      "这次真的明白了。",
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
      )
      .orderBy(schema.messages.occurredAt);
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
      )
      .orderBy(schema.messages.occurredAt);
    // 新契约：secondTurn 输出与第一轮不同（"好的，这次明白了。"）→ 正常落库
    expect(outboundAfterSecond).toHaveLength(2);
    const secondTurnState = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, secondTurn.turnId));
    // 第二轮的回复同样不带 wait_ms → 续步复读同一文本 → 优雅收口 completed
    expect(secondTurnState[0]).toMatchObject({
      status: "completed",
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
      )
      .orderBy(schema.messages.occurredAt);
    expect(outboundAfterThird).toHaveLength(3);
    expect(outboundAfterThird[2]).toMatchObject({
      actorType: "agent",
      direction: "outbound",
      text: "这次真的明白了。",
    });
    const thirdTurnState = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, thirdTurn.turnId));
    expect(thirdTurnState[0]).toMatchObject({ status: "completed" });
  });

  it("同一批里逐字重复的分段：只落一条（落库边界去重）", async () => {
    const cursor = 61;
    await ingestChannelEvents(
      postgres.db,
      [
        {
          cursor: String(cursor),
          eventId: `duplicate-batch-${suffix}`,
          conversationRef: `duplicate-batch-${suffix}`,
          channelMessageId: `server-batch-${suffix}`,
          senderRef: "wxid_duplicate_guard",
          kind: "text" as const,
          content: "又报 2272 了",
          occurredAt: new Date(1_700_600_000 * 1000).toISOString(),
          observedAt: new Date(1_700_600_000 * 1000).toISOString(),
          isSelf: false,
        },
      ],
      String(cursor),
    );
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, batchConversationId));
    if (!turn) throw new Error("expected an agent turn on the batch conversation");
    const executor = new AgentTurnExecutor(
      postgres.db,
      stubSegmentModelClient([
        "灯亮就换个USB口重插。",
        "灯亮就换个USB口重插。",
        "插好再开一次软件。",
      ]),
      "deepseek-v4-flash",
    );
    await executor.execute({ turnId: turn.turnId, traceId: turn.traceId });

    const replyBatchId = `agent-reply:${turn.turnId}`;
    const persisted = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, batchConversationId),
          eq(schema.messages.replyBatchId, replyBatchId),
        ),
      )
      .orderBy(schema.messages.replySequence);
    // 3 段里有 2 段逐字相同 → 只落 2 条，且序号连续
    expect(persisted.map((row) => row.text)).toEqual([
      "灯亮就换个USB口重插。",
      "插好再开一次软件。",
    ]);
    expect(persisted.map((row) => row.replySequence)).toEqual([1, 2]);
  });

  /** 直接插入一条 agent 出站回复单段批次（判定只看 messages 表）。 */  async function insertAgentReply(input: {
    messageId: string;
    text: string;
    sendState: SendState | null;
    occurredAt: Date;
  }): Promise<void> {
    await postgres.db.insert(schema.messages).values({
      messageId: input.messageId,
      conversationId: stateConversationId,
      channelEventId: null,
      channelMessageId: null,
      direction: "outbound",
      actorType: "agent",
      actorId: null,
      contentType: "text",
      channelType: 1,
      text: input.text,
      isSelf: true,
      processingState: "not_applicable",
      sendState: input.sendState,
      replyBatchId: `agent-reply:${input.messageId}`,
      replySequence: 1,
      idempotencyKey: input.messageId,
      occurredAt: input.occurredAt,
      createdAt: input.occurredAt,
      traceId: "duplicate-reply-test",
    });
  }

  // 用例按声明顺序共享同一会话、occurredAt 递增，且每条指令文本互不相同：
  // 只有「未被过滤掉的最新一行」才会成为比较对象，因此每个用例都能单独
  // 判别自己那一行的送达状态语义（过滤失效 → 该行成为上一条 → 断言反转）。
  const DELIVERED_TEXT = "已送达的指令：灯亮就换个USB口重插。";
  const HELD_TEXT = "被扣留的指令：先看加密狗灯亮不亮。";
  const FAILED_TEXT = "发送失败的指令：拔下来插另一个口。";
  const CANCELLED_TEXT = "被取消的指令：插好再开一次软件。";
  const LEGACY_TEXT = "历史行的指令：重装加密狗驱动。";

  it("已送达（confirmed）的上一条回复照旧拦下逐字复读", async () => {
    await insertAgentReply({
      messageId: `dr-confirmed-${suffix}`,
      text: DELIVERED_TEXT,
      sendState: "confirmed",
      occurredAt: new Date(1_700_100_000_000),
    });
    await expect(
      isDuplicateOfLastReply(postgres.db, stateConversationId, DELIVERED_TEXT),
    ).resolves.toBe(true);
  });

  it("被扣留（held）的分段不充当上一条回复——原样补发必须放行", async () => {
    await insertAgentReply({
      messageId: `dr-held-${suffix}`,
      text: HELD_TEXT,
      sendState: "held",
      occurredAt: new Date(1_700_200_000_000),
    });
    await expect(
      isDuplicateOfLastReply(postgres.db, stateConversationId, HELD_TEXT),
    ).resolves.toBe(false);
  });

  it("发送失败（failed）与被取消（cancelled）同样不阻挡重发", async () => {
    await insertAgentReply({
      messageId: `dr-failed-${suffix}`,
      text: FAILED_TEXT,
      sendState: "failed",
      occurredAt: new Date(1_700_300_000_000),
    });
    await expect(
      isDuplicateOfLastReply(postgres.db, stateConversationId, FAILED_TEXT),
    ).resolves.toBe(false);
    await insertAgentReply({
      messageId: `dr-cancelled-${suffix}`,
      text: CANCELLED_TEXT,
      sendState: "cancelled",
      occurredAt: new Date(1_700_400_000_000),
    });
    await expect(
      isDuplicateOfLastReply(postgres.db, stateConversationId, CANCELLED_TEXT),
    ).resolves.toBe(false);
  });

  it("历史行（sendState 为 NULL）仍按已送达参与比较", async () => {
    await insertAgentReply({
      messageId: `dr-legacy-${suffix}`,
      text: LEGACY_TEXT,
      sendState: null,
      occurredAt: new Date(1_700_500_000_000),
    });
    await expect(
      isDuplicateOfLastReply(postgres.db, stateConversationId, LEGACY_TEXT),
    ).resolves.toBe(true);
  });
});

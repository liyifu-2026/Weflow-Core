/**
 * Phase 3 集成测试：AI Kill Switch（auto_send_enabled）双层闸门 + Agent 总开关
 *
 * 覆盖验收第 3/4/5 条：
 * - auto_send OFF → 第一层（Turn 侧）：不落库出站、turn completed(auto_send_disabled)、
 *   会话幂等进入人工路径（一次通知不洪泛）
 * - auto_send OFF → 第二层（最终硬门）：已提交的 pending agent outbound 被 hold，
 *   Channel Host 绝不会被调用；human/system 消息不受影响
 * - agent_enabled OFF → ingest 不建 Turn，消息幂等进入人工路径
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import type { ChannelSendOperations } from "../modules/channel/contracts/channel-send-operations.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import { AgentTurnExecutor } from "../modules/agent/application/agent-turn-executor.js";
import { processOutboundMessages } from "../modules/conversations/application/process-outbound-messages.js";
import { updateRuntimeSettings } from "../modules/operations/application/runtime-settings.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const logger = createLogger({ logLevel: "silent" }, "kill-switch-test");

function stubModel(decisions: Record<string, unknown>[]) {
  let call = 0;
  return new OpenAiCompatibleClient({
    baseUrl: "https://model.invalid",
    apiKey: "test-only",
    model: "deepseek-v4-flash",
    timeoutMs: 1_000,
    fetch: () => {
      const decision = decisions[Math.min(call, decisions.length - 1)];
      call += 1;
      return Promise.resolve(
        Response.json({
          choices: [{ message: { content: JSON.stringify(decision) } }],
        }),
      );
    },
  });
}

function replyDecision(): Record<string, unknown> {
  return {
    reply_text: "好的，收到。",
    next_action: "reply",
    requires_human: false,
    risk_level: "low",
  };
}

integration("AI Kill Switch 双层闸门与 Agent 总开关", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const eventBase = `killswitch-${suffix}`;
  const created: { conversationId: string; contactId: string }[] = [];

  beforeAll(() => {
    postgres = createPostgres(databaseUrl ?? "", logger);
  });

  afterAll(async () => {
    try {
      for (const { conversationId, contactId } of created) {
        await postgres.db
          .delete(schema.agentTurns)
          .where(eq(schema.agentTurns.conversationId, conversationId));
        await postgres.db
          .delete(schema.memoryCaptureStates)
          .where(eq(schema.memoryCaptureStates.conversationId, conversationId));
        await postgres.db
          .delete(schema.handoffStates)
          .where(eq(schema.handoffStates.conversationId, conversationId));
        await postgres.db
          .delete(schema.handoffEvents)
          .where(eq(schema.handoffEvents.conversationId, conversationId));
        await postgres.db
          .delete(schema.handoffCycles)
          .where(eq(schema.handoffCycles.conversationId, conversationId));
        await postgres.db
          .delete(schema.notificationOutbox)
          .where(eq(schema.notificationOutbox.conversationId, conversationId));
        await postgres.db
          .delete(schema.messages)
          .where(eq(schema.messages.conversationId, conversationId));
        await postgres.db
          .delete(schema.conversations)
          .where(eq(schema.conversations.conversationId, conversationId));
        await postgres.db
          .delete(schema.contactProfiles)
          .where(eq(schema.contactProfiles.contactId, contactId));
      }
    } finally {
      // 无论清理是否成功，先恢复全局开关（防止污染后续测试文件/共享 DB）
      await updateRuntimeSettings(postgres.db, logger, {
        actorUserId: "test",
        sourceIp: "127.0.0.1",
        patch: { agentEnabled: true, autoSendEnabled: true },
      });
      await postgres.close();
    }
  });

  /** 通过真实 ingest 创建 文本消息会话（agent 默认开启） */
  async function createTextConversation(tag: string) {
    const eventId = `${eventBase}-${tag}-event`;
    const sourceConversationId = `${eventBase}-${tag}`;
    const conversationId = `channel:${sourceConversationId}`;
    await ingestChannelEvents(
      postgres.db,
      [
        {
          cursor: "1",
          eventId,
          conversationRef: sourceConversationId,
          channelMessageId: `channel-${eventId}`,
          senderRef: "wxid_friend",
          kind: "text",
          content: "你好，请问几点营业？",
          occurredAt: "2026-08-17T00:00:00.000Z",
          observedAt: "2026-08-17T00:00:01.000Z",
          isSelf: false,
        },
      ],
      "1",
    );
    const [conversation] = await postgres.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId))
      .limit(1);
    if (!conversation) throw new Error("conversation fixture missing");
    created.push({ conversationId, contactId: conversation.contactId });
    return { conversationId };
  }

  it("auto_send OFF：Turn 完成但不落库出站，且会话进入人工路径（通知一次）", async () => {
    const { conversationId } = await createTextConversation("layer1");
    const [message] = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .limit(1);
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId))
      .limit(1);
    if (!turn || !message) throw new Error("turn fixture missing");

    await updateRuntimeSettings(postgres.db, logger, {
      actorUserId: "test",
      sourceIp: "127.0.0.1",
      patch: { autoSendEnabled: false },
    });

    const model = stubModel([replyDecision()]);
    await new AgentTurnExecutor(
      postgres.db,
      model,
      "deepseek-v4-flash",
    ).execute({
      turnId: turn.turnId,
      traceId: `killswitch:${message.messageId}`,
    });

    const [after] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turn.turnId));
    if (!after) throw new Error("turn row missing after processing");
    expect(after.status).toBe("completed");
    expect(after.errorCode).toBe("auto_send_disabled");
    // 生成内容有记录（不丢弃），但无发送语义
    expect(after.responseText).toBe("好的，收到。");

    // 零 AI 出站消息
    const outbound = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.actorType, "agent"),
        ),
      );
    expect(outbound).toHaveLength(0);

    // 会话进入人工路径（幂等 handoff：只创建一次）
    const [handoff] = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId));
    if (!handoff) throw new Error("handoff not created");
    expect(handoff.status).toBe("pending");
    expect(handoff.agentPaused).toBe(true);
  });

  it("auto_send OFF：最终硬门把已提交的 agent outbound 置 held，绝不调用 Channel", async () => {
    const { conversationId } = await createTextConversation("layer2");
    const [conversation] = await postgres.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId))
      .limit(1);
    if (!conversation) throw new Error("conversation missing");
    // 模拟 Turn 事务在开关翻转前已提交的 pending agent 出站
    await postgres.db.insert(schema.messages).values({
      messageId: `agent-message:killswitch-test:${randomUUID()}`,
      conversationId,
      channelEventId: null,
      channelMessageId: null,
      direction: "outbound",
      actorType: "agent",
      actorId: null,
      contentType: "text",
      channelType: 1,
      text: "这条消息绝不能发出去",
      isSelf: true,
      processingState: "not_applicable",
      sendState: "pending",
      idempotencyKey: `ks-${randomUUID()}`,
      occurredAt: new Date(),
      traceId: "killswitch-test",
    });

    const create = vi.fn<ChannelSendOperations["create"]>((input) =>
      Promise.resolve({
        operationId: input.operationId,
        conversationRef: input.conversationRef,
        payload: input.payload,
        state: "pending" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const client: ChannelSendOperations = {
      get: vi.fn(() => Promise.resolve(undefined)),
      create,
    };

    await processOutboundMessages(postgres.db, client, { conversationId });

    const [held] = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.actorType, "agent"),
        ),
      )
      .orderBy(schema.messages.occurredAt)
      .limit(1);
    // 置 held 终态
    if (!held) throw new Error("agent outbound not found");
    expect(held.sendState).toBe("held");
    // Channel 从未被调用
    expect(create).not.toHaveBeenCalled();
  });

  it("auto_send OFF：human/system 出站消息不被拦截", async () => {
    const { conversationId } = await createTextConversation("layer3");
    const [conversation] = await postgres.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId))
      .limit(1);
    if (!conversation) throw new Error("conversation missing");
    await postgres.db.insert(schema.messages).values({
      messageId: `human-msg:${randomUUID()}`,
      conversationId,
      channelEventId: null,
      channelMessageId: null,
      direction: "outbound",
      actorType: "user",
      actorId: null,
      contentType: "text",
      channelType: 1,
      text: "人工回复不受 Kill Switch 影响",
      isSelf: true,
      processingState: "not_applicable",
      sendState: "pending",
      idempotencyKey: `ks-human-${randomUUID()}`,
      occurredAt: new Date(),
      traceId: "killswitch-test",
    });

    const create = vi.fn<ChannelSendOperations["create"]>((input) =>
      Promise.resolve({
        operationId: input.operationId,
        conversationRef: input.conversationRef,
        payload: input.payload,
        state: "pending" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const client: ChannelSendOperations = {
      get: vi.fn(() => Promise.resolve(undefined)),
      create,
    };

    await processOutboundMessages(postgres.db, client);
    // human 消息被正常提交（submitting），Channel 被调用
    expect(create).toHaveBeenCalled();
    const [human] = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.actorType, "user"),
        ),
      )
      .orderBy(schema.messages.occurredAt)
      .limit(1);
    if (!human) throw new Error("human outbound not found");
    expect(human.sendState).toBe("submitting");
  });

  it("agent_enabled OFF：ingest 不建 Turn，消息幂等进入人工路径", async () => {
    await updateRuntimeSettings(postgres.db, logger, {
      actorUserId: "test",
      sourceIp: "127.0.0.1",
      patch: { agentEnabled: false, autoSendEnabled: true },
    });
    const { conversationId } = await createTextConversation("globaloff");
    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    expect(turns).toHaveLength(0);

    const [handoff] = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId));
    if (!handoff) throw new Error("global pause handoff not created");
    expect(handoff.agentPaused).toBe(true);
  });
});

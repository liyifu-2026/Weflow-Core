/**
 * 集成测试：发送期插话闸门（pre-send interjection gate）
 *
 * 契约（outbound_interject_gate_enabled ON 时）：
 * - agent 回复批次分段发送前，批次落库后出现未处理新入站 → 剩余分段
 *   （含本段）置 held + sendError=customer_interjection，发布 reply_interrupted
 * - 私聊任何新入站都扣；群聊仅原提问者（触发消息 actorId）插话才扣；
 *   wake 轮（无触发者）群聊不扣；tool-result 变体豁免（工具结论不可再生）
 * - 开关 OFF：行为与现状逐字节一致（有插话也照发）
 *
 * 锚点语义：分段 createdAt = 批次落库时刻；吸收机制保证落库前插话已
 * 并入最终决策，故仅落库后的入站才算未处理插话。
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import type { ChannelSendOperations } from "../modules/channel/contracts/channel-send-operations.js";
import { conversationEvents } from "../infrastructure/events/conversation-events.js";
import { processOutboundMessages } from "../modules/conversations/application/process-outbound-messages.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const logger = createLogger({ logLevel: "silent" }, "outbound-gate-test");

const GATE_KEY = "outbound_interject_gate_enabled";
const AUTO_SEND_KEY = "auto_send_enabled";

integration("发送期插话闸门", () => {
  let postgres: Postgres | undefined;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const created: { conversationId: string; contactId: string }[] = [];
  let previousAutoSend: string | undefined;

  beforeAll(async () => {
    if (!postgres) postgres = createPostgres(databaseUrl ?? "", logger);
    // 快照 auto_send（kill switch 共用此开关；测试要求它为 ON）
    const [row] = await postgres.db
      .select()
      .from(schema.runtimeSettings)
      .where(eq(schema.runtimeSettings.key, AUTO_SEND_KEY));
    previousAutoSend = row?.value;
    await postgres.db
      .insert(schema.runtimeSettings)
      .values({ key: AUTO_SEND_KEY, value: "true" })
      .onConflictDoUpdate({
        target: schema.runtimeSettings.key,
        set: { value: "true" },
      });
  });

  afterAll(async () => {
    if (!postgres) return;
    for (const { conversationId, contactId } of created) {
      // 回合事件（reply_held）随回合行级联删除；turns.trigger_message_id
      // 反指 messages，故必须先删回合再删消息。
      await postgres.db
        .delete(schema.agentTurns)
        .where(eq(schema.agentTurns.conversationId, conversationId));
      await postgres.db
        .delete(schema.agentTurnEvents)
        .where(eq(schema.agentTurnEvents.conversationId, conversationId));
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
    // 还原闸门与 auto_send 开关，不污染共享测试库
    await postgres.db
      .delete(schema.runtimeSettings)
      .where(eq(schema.runtimeSettings.key, GATE_KEY));
    if (previousAutoSend === undefined) {
      await postgres.db
        .delete(schema.runtimeSettings)
        .where(eq(schema.runtimeSettings.key, AUTO_SEND_KEY));
    } else {
      await postgres.db
        .update(schema.runtimeSettings)
        .set({ value: previousAutoSend })
        .where(eq(schema.runtimeSettings.key, AUTO_SEND_KEY));
    }
    await postgres.close();
  });

  async function setGate(value: "true" | "false"): Promise<void> {
    if (!postgres) throw new Error("postgres not ready");
    await postgres.db
      .insert(schema.runtimeSettings)
      .values({ key: GATE_KEY, value })
      .onConflictDoUpdate({
        target: schema.runtimeSettings.key,
        set: { value },
      });
  }

  async function createConversation(
    tag: string,
    chatType: "private" | "group",
  ): Promise<string> {
    if (!postgres) throw new Error("postgres not ready");
    const conversationId = `channel:oig-${suffix}-${tag}`;
    const contactId = `contact:channel:oig-${suffix}-${tag}`;
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `oig-${suffix}-${tag}-contact`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `oig-${suffix}-${tag}-ref`,
      chatType,
    });
    created.push({ conversationId, contactId });
    return conversationId;
  }

  type InsertBatchInput = {
    conversationId: string;
    tag: string;
    /** replyBatchId 中的 turnId（如 turn:{triggerMessageId} 或 turn:wake:x） */
    turnId: string;
    variantSuffix?: string;
    segmentCount: number;
    committedAt: Date;
  };

  /** 插入一个 agent 回复批次（分段全部 pending；createdAt 递增保证循环顺序确定） */
  async function insertAgentBatch(input: InsertBatchInput): Promise<string[]> {
    if (!postgres) throw new Error("postgres not ready");
    const replyBatchId = `agent-reply:${input.turnId}${input.variantSuffix ?? ""}`;
    const ids: string[] = [];
    for (let index = 0; index < input.segmentCount; index += 1) {
      const messageId = `oig:${suffix}:${input.tag}:seg${String(index + 1)}`;
      const committedAt = new Date(input.committedAt.getTime() + index);
      await postgres.db.insert(schema.messages).values({
        messageId,
        conversationId: input.conversationId,
        channelEventId: null,
        channelMessageId: null,
        direction: "outbound",
        actorType: "agent",
        actorId: null,
        contentType: "text",
        channelType: 1,
        text: `插话闸门测试分段 ${input.tag}#${String(index + 1)}`,
        isSelf: true,
        processingState: "not_applicable",
        sendState: "pending",
        replyBatchId,
        replySequence: index + 1,
        idempotencyKey: messageId,
        occurredAt: input.committedAt,
        createdAt: committedAt,
        traceId: "outbound-gate-test",
      });
      ids.push(messageId);
    }
    return ids;
  }

  async function insertInbound(input: {
    conversationId: string;
    tag: string;
    /** 显式指定 messageId（群聊用例需与 replyBatchId 的 turn:{id} 对齐） */
    messageId?: string;
    actorId: string | null;
    at: Date;
    text?: string;
  }): Promise<string> {
    if (!postgres) throw new Error("postgres not ready");
    const messageId = input.messageId ?? `oig:${suffix}:${input.tag}`;
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId: input.conversationId,
      channelEventId: null,
      channelMessageId: null,
      direction: "inbound",
      actorType: "user",
      actorId: input.actorId,
      contentType: "text",
      channelType: 1,
      text: input.text ?? "插话测试消息",
      isSelf: false,
      processingState: "done",
      sendState: null,
      idempotencyKey: messageId,
      occurredAt: input.at,
      createdAt: input.at,
      traceId: "outbound-gate-test",
    });
    return messageId;
  }

  function okChannelClient(): ChannelSendOperations {
    return {
      get: vi.fn(() => Promise.resolve(undefined)),
      create: vi.fn<ChannelSendOperations["create"]>((input) =>
        Promise.resolve({
          operationId: input.operationId,
          conversationRef: input.conversationRef,
          payload: input.payload,
          state: "pending" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      ),
    };
  }

  async function loadMessage(messageId: string) {
    if (!postgres) throw new Error("postgres not ready");
    const [row] = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, messageId));
    if (!row) throw new Error(`message ${messageId} missing`);
    return row;
  }

  /** 订阅 reply_interrupted 事件（按会话过滤），返回停止订阅 + 事件数组 */
  function collectInterrupted(conversationId: string) {
    const events: { messageId: string | undefined }[] = [];
    const stop = conversationEvents.on((event) => {
      if (
        event.type === "reply_interrupted" &&
        event.conversationId === conversationId
      ) {
        events.push({ messageId: event.messageId });
      }
    });
    return { events, stop };
  }

  it("开关 OFF：有插话也照发（现状行为逐字节一致）", async () => {
    await setGate("false");
    const conversationId = await createConversation("off", "private");
    const triggerId = `oig-off-trigger-${suffix}`;
    await insertInbound({
      conversationId,
      tag: `off-trigger-${suffix}`,
      actorId: "wxid_cust",
      at: new Date(Date.now() - 120_000),
    });
    const committedAt = new Date(Date.now() - 60_000);
    const ids = await insertAgentBatch({
      conversationId,
      tag: "off",
      turnId: `turn:${triggerId}`,
      segmentCount: 3,
      committedAt,
    });
    await insertInbound({
      conversationId,
      tag: `off-interject-${suffix}`,
      actorId: "wxid_cust",
      at: new Date(Date.now() - 30_000),
    });

    await processOutboundMessages(postgres!.db, okChannelClient(), {
      logger,
      conversationId,
    });

    expect((await loadMessage(ids[0]!)).sendState).toBe("submitting");
    expect((await loadMessage(ids[1]!)).sendState).toBe("pending");
    expect((await loadMessage(ids[2]!)).sendState).toBe("pending");
  });

  it("私聊插话：未发分段全部扣留 + reply_interrupted 发布", async () => {
    await setGate("true");
    const conversationId = await createConversation("private", "private");
    const triggerId = `oig-private-trigger-${suffix}`;
    await insertInbound({
      conversationId,
      tag: `private-trigger-${suffix}`,
      messageId: triggerId,
      actorId: "wxid_cust",
      at: new Date(Date.now() - 120_000),
    });
    const committedAt = new Date(Date.now() - 60_000);
    // 回合行：reply_held 回合事件对 agent.turns 有外键，必须先有回合。
    await postgres!.db.insert(schema.agentTurns).values({
      turnId: `turn:${triggerId}`,
      triggerMessageId: triggerId,
      conversationId,
      status: "running",
      traceId: `trace-oig-private-${suffix}`,
    });
    const ids = await insertAgentBatch({
      conversationId,
      tag: "private",
      turnId: `turn:${triggerId}`,
      segmentCount: 3,
      committedAt,
    });
    await insertInbound({
      conversationId,
      tag: `private-interject-${suffix}`,
      actorId: "wxid_cust",
      at: new Date(Date.now() - 30_000),
    });

    const { events, stop } = collectInterrupted(conversationId);
    const client = okChannelClient();
    // 单轮 pass 内顺序闸门与插话闸门协同：首段先扣，后续分段被字节拍/
    // 前序闸门挡住，扣留在后续 pass 中逐段生效（生产即轮询节奏）。
    // 回拨 sendUpdatedAt 跳过真实等待。
    for (let pass = 0; pass < ids.length; pass += 1) {
      await processOutboundMessages(postgres!.db, client, {
        logger,
        conversationId,
      });
      const held = await loadMessage(ids[pass]!);
      if (held.sendState !== "held") break;
      await postgres!.db
        .update(schema.messages)
        .set({ sendUpdatedAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.messages.messageId, ids[pass]!));
    }
    stop();

    for (const id of ids) {
      const row = await loadMessage(id);
      expect(row.sendState).toBe("held");
      expect(row.sendError).toBe("customer_interjection");
    }
    expect(client.create).not.toHaveBeenCalled();
    // 每批至多发布一次，首个被扣段携带 messageId
    expect(events).toHaveLength(1);
    expect(events[0]?.messageId).toBe(ids[0]);
    // 总线事件之外必须落一条可事后查询的回合事件（运营排错证据链）
    const heldEvents = await postgres!.db
      .select()
      .from(schema.agentTurnEvents)
      .where(
        and(
          eq(schema.agentTurnEvents.turnId, `turn:${triggerId}`),
          eq(schema.agentTurnEvents.eventType, "reply_held"),
        ),
      );
    expect(heldEvents).toHaveLength(1);
    expect(heldEvents[0]).toMatchObject({
      conversationId,
      reasonCode: "customer_interjection",
    });
    expect(heldEvents[0]?.payload).toMatchObject({
      replyBatchId: `agent-reply:turn:${triggerId}`,
      variant: "direct",
      heldFromSequence: 1,
    });
  });

  it("私聊无插话：首段照发、后续分段等下一轮（既有顺序闸门）", async () => {
    await setGate("true");
    const conversationId = await createConversation("no-hit", "private");
    const triggerId = `oig-nohit-trigger-${suffix}`;
    await insertInbound({
      conversationId,
      tag: `nohit-trigger-${suffix}`,
      actorId: "wxid_cust",
      at: new Date(Date.now() - 120_000),
    });
    const ids = await insertAgentBatch({
      conversationId,
      tag: "nohit",
      turnId: `turn:${triggerId}`,
      segmentCount: 3,
      committedAt: new Date(Date.now() - 60_000),
    });

    const client = okChannelClient();
    await processOutboundMessages(postgres!.db, client, {
      logger,
      conversationId,
    });

    expect((await loadMessage(ids[0]!)).sendState).toBe("submitting");
    expect((await loadMessage(ids[1]!)).sendState).toBe("pending");
    expect((await loadMessage(ids[2]!)).sendState).toBe("pending");
  });

  it("tool-result 批次：插话也照发（工具结论不可再生）", async () => {
    await setGate("true");
    const conversationId = await createConversation("tool", "private");
    const triggerId = `oig-tool-trigger-${suffix}`;
    await insertInbound({
      conversationId,
      tag: `tool-trigger-${suffix}`,
      actorId: "wxid_cust",
      at: new Date(Date.now() - 120_000),
    });
    const ids = await insertAgentBatch({
      conversationId,
      tag: "tool",
      turnId: `turn:${triggerId}`,
      variantSuffix: ":tool-result",
      segmentCount: 2,
      committedAt: new Date(Date.now() - 60_000),
    });
    await insertInbound({
      conversationId,
      tag: `tool-interject-${suffix}`,
      actorId: "wxid_cust",
      at: new Date(Date.now() - 30_000),
    });

    await processOutboundMessages(postgres!.db, okChannelClient(), {
      logger,
      conversationId,
    });

    expect((await loadMessage(ids[0]!)).sendState).toBe("submitting");
    expect((await loadMessage(ids[1]!)).sendState).toBe("pending");
  });

  it("群聊：路人插话照发，原提问者插话扣留", async () => {
    await setGate("true");
    const triggerAt = new Date(Date.now() - 120_000);
    const committedAt = new Date(Date.now() - 60_000);
    const interjectAt = new Date(Date.now() - 30_000);

    // 路人插话：不扣
    const strangerConv = await createConversation("grp-stranger", "group");
    const strangerTrigger = `oig-grps-trigger-${suffix}`;
    await insertInbound({
      conversationId: strangerConv,
      tag: `grps-trigger-${suffix}`,
      messageId: strangerTrigger,
      actorId: "wxid_asker",
      at: triggerAt,
    });
    const [strangerSeg] = await insertAgentBatch({
      conversationId: strangerConv,
      tag: "grps",
      turnId: `turn:${strangerTrigger}`,
      segmentCount: 1,
      committedAt,
    });
    await insertInbound({
      conversationId: strangerConv,
      tag: `grps-interject-${suffix}`,
      actorId: "wxid_bystander",
      at: interjectAt,
    });
    await processOutboundMessages(postgres!.db, okChannelClient(), {
      logger,
      conversationId: strangerConv,
    });
    expect((await loadMessage(strangerSeg!)).sendState).toBe("submitting");

    // 原提问者插话：扣
    const askerConv = await createConversation("grp-asker", "group");
    const askerTrigger = `oig-grpa-trigger-${suffix}`;
    await insertInbound({
      conversationId: askerConv,
      tag: `grpa-trigger-${suffix}`,
      messageId: askerTrigger,
      actorId: "wxid_asker",
      at: triggerAt,
    });
    const [askerSeg] = await insertAgentBatch({
      conversationId: askerConv,
      tag: "grpa",
      turnId: `turn:${askerTrigger}`,
      segmentCount: 1,
      committedAt,
    });
    await insertInbound({
      conversationId: askerConv,
      tag: `grpa-interject-${suffix}`,
      actorId: "wxid_asker",
      at: interjectAt,
    });
    await processOutboundMessages(postgres!.db, okChannelClient(), {
      logger,
      conversationId: askerConv,
    });
    const askerRow = await loadMessage(askerSeg!);
    expect(askerRow.sendState).toBe("held");
    expect(askerRow.sendError).toBe("customer_interjection");
  });

  it("群聊 wake 轮（无触发者基准）：插话也照发", async () => {
    await setGate("true");
    const conversationId = await createConversation("grp-wake", "group");
    const ids = await insertAgentBatch({
      conversationId,
      tag: "grpw",
      turnId: `turn:wake:${suffix}`,
      segmentCount: 1,
      committedAt: new Date(Date.now() - 60_000),
    });
    await insertInbound({
      conversationId,
      tag: `grpw-interject-${suffix}`,
      actorId: "wxid_anyone",
      at: new Date(Date.now() - 30_000),
    });

    await processOutboundMessages(postgres!.db, okChannelClient(), {
      logger,
      conversationId,
    });

    expect((await loadMessage(ids[0]!)).sendState).toBe("submitting");
  });
});

/**
 * Decision disposition → outcome-command 真库集成测试。
 *
 * 此前 decision-disposition 的单元测试全量 mock 掉 outcome-command，
 * 「回复 + 轮次终态 + 事件 + 记忆调度在同一事务内原子提交」的核心
 * 不变量从未对真库验证过。本套件用真实 Postgres 钉住：
 * - reply 决策：messages + agent_turns(completed) + reply_persisted 事件
 *   + memory_capture_states 调度 同事务落库；
 * - 回复校验失败：轮次 failed + validation_failed 事件，零消息落库；
 * - 重复回复：优雅收口（completed），不再二发消息。
 */
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import {
  commitDecisionDisposition,
} from "../modules/agent/application/decision-disposition.js";
import type { AgentDecision } from "../modules/agent/application/agent-decision.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("decision disposition atomic outcome (real db)", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationId = `channel:disp-outcome-${suffix}`;
  const contactId = `contact:channel:disp-outcome-${suffix}`;

  const insertTriggerMessage = (messageId: string) =>
    postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text: "文件打不开了",
      processingState: "received",
      idempotencyKey: messageId,
      occurredAt: new Date(),
      traceId: messageId,
    });

  const insertRunningTurn = (turnId: string, triggerMessageId: string) =>
    postgres.db.insert(schema.agentTurns).values({
      turnId,
      triggerMessageId,
      conversationId,
      status: "running",
      traceId: turnId,
    });

  const replyDecision = (text: string): AgentDecision => ({
    replySegments: [text],
    replyText: text,
    nextAction: "reply",
    noActionReason: undefined,
    requiresHuman: false,
    riskLevel: "low",
    tool: undefined,
    knowledgeQuery: undefined,
    handoffBriefing: undefined,
    waitMs: undefined,
    scheduledMessage: undefined,
    scheduledSendAt: undefined,
    nudgeText: undefined,
    closureSummary: undefined,
    factsCard: undefined,
  });

  /** 本轮次名下的出站回复（按 replyBatchId 内嵌 turnId 作用域，互不污染）。 */
  const repliesForTurn = (turnId: string) =>
    postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.direction, "outbound"),
          like(schema.messages.replyBatchId, `agent-reply:${turnId}%`),
        ),
      );

  const disposition = (turnId: string, decision: AgentDecision) =>
    commitDecisionDisposition({
      db: postgres.db,
      decision,
      turnId,
      conversationId,
      traceId: `trace:${turnId}`,
      path: "fresh",
      chatType: "private",
      triggerMessageId: `msg:${turnId}`,
      conversationRevision: 1,
      model: "test-model",
      aiEmployeeId: null,
      allowReplyContinuation: false,
    });

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "disp-outcome-test"),
    );
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `disp-outcome-${suffix}`,
      agentEnabled: true,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `disp-outcome-${suffix}`,
    });
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.agentTurnEvents)
      .where(eq(schema.agentTurnEvents.conversationId, conversationId));
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(eq(schema.memoryCaptureStates.conversationId, conversationId));
    // turns.trigger_message_id → messages：先删轮次再删消息
    await postgres.db
      .delete(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    await postgres.db
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, contactId));
    await postgres.close();
  });

  it("reply 决策：消息/轮次终态/事件/记忆调度同事务原子提交", async () => {
    const turnId = `turn:disp-outcome-reply-${suffix}`;
    const triggerId = `msg:${turnId}`;
    await insertTriggerMessage(triggerId);
    await insertRunningTurn(turnId, triggerId);

    const result = await disposition(turnId, replyDecision("重启电脑后再试一次。"));

    expect(result).toEqual({ action: "terminal" });
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId));
    expect(turn).toMatchObject({
      status: "completed",
      responseText: "重启电脑后再试一次。",
    });
    const replies = await repliesForTurn(turnId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      actorType: "agent",
      sendState: "pending",
      text: "重启电脑后再试一次。",
    });
    expect(replies[0]?.replyBatchId ?? "").toContain(turnId);
    const events = await postgres.db
      .select()
      .from(schema.agentTurnEvents)
      .where(eq(schema.agentTurnEvents.turnId, turnId));
    expect(events.some((event) => event.eventType === "reply_persisted")).toBe(
      true,
    );
    const [memory] = await postgres.db
      .select()
      .from(schema.memoryCaptureStates)
      .where(eq(schema.memoryCaptureStates.conversationId, conversationId));
    expect(memory).toBeDefined();
  });

  it("回复校验失败：轮次 failed + validation_failed 事件，零消息落库", async () => {
    const turnId = `turn:disp-outcome-invalid-${suffix}`;
    const triggerId = `msg:${turnId}`;
    await insertTriggerMessage(triggerId);
    await insertRunningTurn(turnId, triggerId);

    const result = await disposition(
      turnId,
      replyDecision("长".repeat(600)),
    );

    expect(result).toEqual({ action: "terminal" });
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId));
    expect(turn).toMatchObject({ status: "failed" });
    const events = await postgres.db
      .select()
      .from(schema.agentTurnEvents)
      .where(eq(schema.agentTurnEvents.turnId, turnId));
    expect(
      events.some((event) => event.eventType === "validation_failed"),
    ).toBe(true);
    const replies = await repliesForTurn(turnId);
    expect(replies).toHaveLength(0);
  });

  it("重复回复：优雅收口为 completed，不再二发消息", async () => {
    const turnId = `turn:disp-outcome-dup-${suffix}`;
    const triggerId = `msg:${turnId}`;
    await insertTriggerMessage(triggerId);
    await insertRunningTurn(turnId, triggerId);

    await disposition(turnId, replyDecision("请重新插拔一下设备。"));
    // 同一会话上一条 agent 回复逐字相同的新轮次：isDuplicateOfLastReply 命中
    const turnId2 = `turn:disp-outcome-dup2-${suffix}`;
    await insertTriggerMessage(`msg:${turnId2}`);
    await insertRunningTurn(turnId2, `msg:${turnId2}`);
    const result = await disposition(turnId2, replyDecision("请重新插拔一下设备。"));

    expect(result).toEqual({ action: "terminal" });
    const [dupTurn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId2));
    expect(dupTurn).toMatchObject({ status: "completed" });
    const replies = await repliesForTurn(turnId2);
    // 第二轮未新增消息（重复内容不二发）
    expect(replies).toHaveLength(0);
  });
});

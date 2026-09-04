/**
 * AgentTurnExecutor 分支覆盖
 *
 * ADR-0001：Agent Turn 统一通过 AgentTurnExecutor.execute() 进入。
 * 本套件覆盖 Executor 特有分支：
 * - 终态轮次（superseded）直接短路返回，不再触发模型调用
 * - 未知状态规范化为 unknown
 * - queued 轮次带有效工具租约时让位给当前持有者（不重复 claim）
 * - 不存在的轮次直接报错
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { AgentTurnExecutor } from "../modules/agent/application/agent-turn-executor.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("AgentTurnExecutor execution branches", () => {
  let postgres: Postgres;
  let modelCalls = 0;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationId = `channel:turn-executor-${suffix}`;
  const contactId = `contact:channel:turn-executor-${suffix}`;

  const insertMessage = (messageId: string) =>
    postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text: "你好",
      processingState: "received",
      idempotencyKey: messageId,
      occurredAt: new Date(),
      traceId: messageId,
    });

  const insertTurn = (
    turnId: string,
    triggerMessageId: string,
    status: string,
  ) =>
    postgres.db.insert(schema.agentTurns).values({
      turnId,
      triggerMessageId,
      conversationId,
      status,
      traceId: turnId,
    });

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "turn-executor-test"),
    );
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `turn-executor-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `turn-executor-${suffix}`,
    });
  });

  afterAll(async () => {
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

  const modelClient = () =>
    new OpenAiCompatibleClient({
      baseUrl: "https://model.invalid",
      apiKey: "test-only",
      model: "test",
      timeoutMs: 1_000,
      fetch: () => {
        modelCalls += 1;
        return Promise.resolve(Response.json({ choices: [] }));
      },
    });

  it("rejects when the turn does not exist", async () => {
    await expect(
      new AgentTurnExecutor(postgres.db, modelClient(), "test").execute({
        turnId: `turn-executor-missing-${suffix}`,
        traceId: "turn-executor-test",
      }),
    ).rejects.toThrow("does not exist");
    expect(modelCalls).toBe(0);
  });

  it("returns a superseded turn without executing", async () => {
    const messageId = `turn-executor-superseded-msg-${suffix}`;
    const turnId = `turn-executor-superseded-${suffix}`;
    await insertMessage(messageId);
    await insertTurn(turnId, messageId, "superseded");

    const result = await new AgentTurnExecutor(
      postgres.db,
      modelClient(),
      "test",
    ).execute({ turnId, traceId: turnId });

    expect(result).toEqual({
      turnId,
      conversationId,
      status: "superseded",
      resumed: false,
    });
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId));
    expect(turn).toMatchObject({ status: "superseded", attempt: 0 });
    expect(modelCalls).toBe(0);
  });

  it("normalizes an unrecognized persisted status to unknown", async () => {
    const messageId = `turn-executor-stale-status-msg-${suffix}`;
    const turnId = `turn-executor-stale-status-${suffix}`;
    await insertMessage(messageId);
    await insertTurn(turnId, messageId, "awaiting_channel_sync");

    const result = await new AgentTurnExecutor(
      postgres.db,
      modelClient(),
      "test",
    ).execute({ turnId, traceId: turnId });

    expect(result).toMatchObject({
      turnId,
      conversationId,
      status: "unknown",
      resumed: false,
    });
    expect(modelCalls).toBe(0);
  });

  it("leaves a queued turn with a live tool lease to its current owner", async () => {
    const messageId = `turn-executor-lease-msg-${suffix}`;
    const turnId = `turn-executor-lease-${suffix}`;
    const executionId = `agent-tool:${turnId}`;
    await insertMessage(messageId);
    await insertTurn(turnId, messageId, "queued");
    await postgres.db.insert(schema.toolExecutions).values({
      executionId,
      turnId,
      conversationId,
      toolName: "query_contact_profile",
      status: "running",
      idempotencyKey: executionId,
      arguments: {},
      claimedAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
    });

    const result = await new AgentTurnExecutor(
      postgres.db,
      modelClient(),
      "test",
    ).execute({ turnId, traceId: turnId });

    expect(result).toMatchObject({
      turnId,
      conversationId,
      status: "queued",
      resumed: true,
    });
    // 未发生 claim：attempt 不变，也没有写入任何阶段事件
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId));
    if (!turn) throw new Error("turn missing after lease check");
    expect(turn.attempt).toBe(0);
    const events = await postgres.db
      .select()
      .from(schema.agentTurnEvents)
      .where(eq(schema.agentTurnEvents.turnId, turnId));
    expect(events).toHaveLength(0);
    expect(modelCalls).toBe(0);
  });
});

/**
 * 工具失败降级（工具失败不再直接转人工）：
 * - 持久化为 failed 的工具执行以「失败回执」进入恢复提示词；
 * - fresh 检索抛错同样走失败回执；
 * 两种路径模型都应能直接作答收尾，会话不产生 Handoff。
 */
integration("AgentTurnExecutor tool failure degradation", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}-toolfail`;
  const conversationId = `channel:turn-executor-tf-${suffix}`;
  const contactId = `contact:channel:turn-executor-tf-${suffix}`;

  const decisionClient = (decision: string) => {
    let modelCalls = 0;
    const client = new OpenAiCompatibleClient({
      baseUrl: "https://model.invalid",
      apiKey: "test-only",
      model: "test",
      timeoutMs: 1_000,
      fetch: () => {
        modelCalls += 1;
        return Promise.resolve(
          Response.json({ choices: [{ message: { content: decision } }] }),
        );
      },
    });
    return { client, calls: () => modelCalls };
  };

  const insertConversationFixture = async (label: string) => {
    const localConversationId = `${conversationId}-${label}`;
    const localContactId = `${contactId}-${label}`;
    await postgres.db.insert(schema.contactProfiles).values({
      contactId: localContactId,
      channel: "channel",
      channelContactId: `turn-executor-tf-${label}-${suffix}`,
      agentEnabled: true,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId: localConversationId,
      contactId: localContactId,
      channel: "channel",
      channelConversationId: `turn-executor-tf-${label}-${suffix}`,
    });
    return { localConversationId, localContactId };
  };

  const insertToolTurn = async (
    label: string,
    localConversationId: string,
    executionStatus: "failed" | "planned",
  ) => {
    const messageId = `turn-executor-tf-${label}-msg-${suffix}`;
    const turnId = `turn-executor-tf-${label}-${suffix}`;
    const executionId = `agent-tool:${turnId}`;
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId: localConversationId,
      direction: "inbound",
      actorType: "contact",
      contentType: "text",
      channelType: 1,
      text: "设备报错 2272 怎么处理？",
      processingState: "received",
      idempotencyKey: messageId,
      occurredAt: new Date(),
      traceId: messageId,
    });
    await postgres.db.insert(schema.agentTurns).values({
      turnId,
      triggerMessageId: messageId,
      conversationId: localConversationId,
      status: "tool_planned",
      traceId: turnId,
    });
    await postgres.db.insert(schema.toolExecutions).values({
      executionId,
      turnId,
      conversationId: localConversationId,
      toolName: "retrieve_knowledge",
      status: executionStatus,
      ...(executionStatus === "failed"
        ? { errorCode: "weknora_request_failed:503" }
        : {}),
      idempotencyKey: executionId,
      arguments: { query: "设备报错 2272" },
    });
    return turnId;
  };

  beforeAll(() => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "turn-executor-toolfail-test"),
    );
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.toolExecutions)
      .where(sql`conversation_id LIKE ${`${conversationId}%`}`);
    await postgres.db
      .delete(schema.agentTurns)
      .where(sql`conversation_id LIKE ${`${conversationId}%`}`);
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(sql`conversation_id LIKE ${`${conversationId}%`}`);
    await postgres.db
      .delete(schema.messages)
      .where(sql`conversation_id LIKE ${`${conversationId}%`}`);
    await postgres.db
      .delete(schema.conversations)
      .where(sql`conversation_id LIKE ${`${conversationId}%`}`);
    await postgres.db
      .delete(schema.contactProfiles)
      .where(sql`contact_id LIKE ${`${contactId}%`}`);
    await postgres.close();
  });

  it("已持久化的失败工具执行走失败回执：模型直接作答，不转人工", async () => {
    const { localConversationId } = await insertConversationFixture(
      "persisted",
    );
    const turnId = await insertToolTurn("persisted", localConversationId, "failed");
    const decision = JSON.stringify({
      next_action: "reply",
      reply_text: "抱歉，该项查询暂时不可用，请稍后再试。",
      requires_human: false,
      risk_level: "low",
    });
    const { client, calls } = decisionClient(decision);

    const result = await new AgentTurnExecutor(postgres.db, client, "test", {
      knowledgeSearch: {
        search: () =>
          Promise.reject(
            new Error("knowledge search must not run for a failed execution"),
          ),
      },
    }).execute({ turnId, traceId: turnId });

    expect(result.status).toBe("completed");
    expect(calls()).toBe(1);
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId));
    expect(turn).toMatchObject({ status: "completed" });
    const handoffs = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, localConversationId));
    expect(handoffs).toHaveLength(0);
    const outbound = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, localConversationId),
          eq(schema.messages.direction, "outbound"),
        ),
      );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ sendState: "pending" });
  });

  it("检索工具执行时抛错同样走失败回执：不转人工", async () => {
    const { localConversationId } = await insertConversationFixture("fresh");
    const turnId = await insertToolTurn("fresh", localConversationId, "planned");
    const decision = JSON.stringify({
      next_action: "reply",
      reply_text: "抱歉，我暂时查不到相关资料，请您稍后再问或换个说法。",
      requires_human: false,
      risk_level: "low",
    });
    const { client, calls } = decisionClient(decision);

    const result = await new AgentTurnExecutor(postgres.db, client, "test", {
      knowledgeSearch: {
        search: () => Promise.reject(new Error("weknora_request_failed:503")),
      },
    }).execute({ turnId, traceId: turnId });

    expect(result.status).toBe("completed");
    expect(calls()).toBe(1);
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId));
    expect(turn).toMatchObject({ status: "completed" });
    const handoffs = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, localConversationId));
    expect(handoffs).toHaveLength(0);
    const outbound = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, localConversationId),
          eq(schema.messages.direction, "outbound"),
        ),
      );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ sendState: "pending" });
  });
});

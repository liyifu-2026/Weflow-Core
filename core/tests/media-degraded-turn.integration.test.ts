/**
 * Phase 2 集成测试：图片消息不得静默死亡
 *
 * 覆盖：
 * - 视觉能力未配置时，视觉阶段媒体短路失败（vision_not_configured）
 * - 视觉阶段停滞媒体超时恢复（stale_timeout）
 * - failed 媒体自动创建降级 Turn（无图片描述），且降级 Turn 可完整执行产出回复
 * - 幂等：同一消息不会重复创建降级 Turn
 * - 会话在人工接管（agentPaused）或联系人 agentEnabled=false 时不创建降级 Turn
 * - Agent 上下文中无描述图片渲染占位文案（模型知道存在图片但无法查看）
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import { readRuntimeSettings } from "../modules/operations/application/runtime-settings.js";
import { processAgentTurn } from "../modules/agent/application/process-agent-turn.js";
import { buildAgentContext } from "../modules/agent/application/agent-context.js";
import { createHandoff } from "../modules/handoff/application/handoff-service.js";
import {
  createDegradedTurns,
  failMediaWithoutVision,
  recoverStaleMedia,
} from "../infrastructure/redis/media-processing-dispatcher.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

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

integration("media degraded turn（图片消息不得静默死亡）", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const eventBase = `media-degraded-${suffix}`;
  const created: { conversationId: string; contactId: string }[] = [];

  beforeAll(() => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "media-degraded-test"),
    );
  });

  afterAll(async () => {
    for (const { conversationId, contactId } of created) {
      await postgres.db
        .delete(schema.mediaAssets)
        .where(eq(schema.mediaAssets.conversationId, conversationId));
      await postgres.db
        .delete(schema.agentTurns)
        .where(eq(schema.agentTurns.conversationId, conversationId));
      await postgres.db
        .delete(schema.caseStates)
        .where(eq(schema.caseStates.conversationId, conversationId));
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
    await postgres.close();
  });

  /** 通过真实 ingest 创建 联系人/会话/图片消息/media 资产 */
  async function createImageConversation(tag: string) {
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
          kind: "image",
          content: "[image]",
          mediaRef: `media:${eventId}`,
          occurredAt: "2026-08-17T00:00:00.000Z",
          observedAt: "2026-08-17T00:00:01.000Z",
          isSelf: false,
        },
      ],
      "1",
    );
    const [media] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, conversationId))
      .limit(1);
    const [message] = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .limit(1);
    const [conversation] = await postgres.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId))
      .limit(1);
    if (!media || !message || !conversation) {
      throw new Error(`fixture missing for ${tag}`);
    }
    created.push({ conversationId, contactId: conversation.contactId });
    return { eventId, conversationId, media, message };
  }

  it("视觉未配置时：视觉阶段媒体短路失败并创建降级 Turn", async () => {
    const { conversationId, media, message } =
      await createImageConversation("noconf");
    // 模拟图片已下载、等待视觉处理
    await postgres.db
      .update(schema.mediaAssets)
      .set({ status: "processing_queued", updatedAt: new Date() })
      .where(eq(schema.mediaAssets.mediaId, media.mediaId));

    const failed = await failMediaWithoutVision(
      postgres.db,
      createLogger({ logLevel: "silent" }, "test"),
    );
    expect(failed).toBe(1);
    const [after] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, media.mediaId));
    expect(after).toMatchObject({
      status: "failed",
      errorCode: "vision_not_configured",
    });

    const createdTurns = await createDegradedTurns(
      postgres.db,
      createLogger({ logLevel: "silent" }, "test"),
      readRuntimeSettings,
    );
    expect(createdTurns).toBe(1);
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId))
      .limit(1);
    expect(turn).toMatchObject({
      triggerMessageId: message.messageId,
      status: "queued",
    });
  });

  it("failed 媒体（retry_exhausted）创建降级 Turn，且完整执行产出 AI 回复（不静默）", async () => {
    const { conversationId, media } = await createImageConversation("exec");
    await postgres.db
      .update(schema.mediaAssets)
      .set({
        status: "failed",
        errorCode: "retry_exhausted",
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAssets.mediaId, media.mediaId));

    await createDegradedTurns(
      postgres.db,
      createLogger({ logLevel: "silent" }, "test"),
      readRuntimeSettings,
    );
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId))
      .limit(1);
    if (!turn) throw new Error("degraded turn was not created");

    const model = stubModel([replyDecision()]);
    await processAgentTurn(postgres.db, model, "deepseek-v4-flash", {
      turnId: turn.turnId,
      traceId: `media:${media.mediaId}`,
    });

    const [completed] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turn.turnId));
    if (!completed) throw new Error("turn did not complete");
    expect(completed.status).toBe("completed");

    const [outbound] = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.actorType, "agent"),
        ),
      )
      .limit(1);
    if (!outbound) throw new Error("agent outbound reply missing");
    expect(outbound.text).toBe("好的，收到。");

    // 上下文占位文案：模型应能看到"存在图片但无法查看"
    const context = await buildAgentContext(postgres.db, conversationId);
    const historyText = JSON.stringify(context.history);
    expect(historyText).toContain("对方发送了一张图片");
  });

  it("同一消息不会重复创建降级 Turn（幂等）", async () => {
    const { conversationId, media } = await createImageConversation("idem");
    await postgres.db
      .update(schema.mediaAssets)
      .set({
        status: "failed",
        errorCode: "retry_exhausted",
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAssets.mediaId, media.mediaId));

    const logger = createLogger({ logLevel: "silent" }, "test");
    await createDegradedTurns(postgres.db, logger, readRuntimeSettings);
    await createDegradedTurns(postgres.db, logger, readRuntimeSettings);
    await createDegradedTurns(postgres.db, logger, readRuntimeSettings);

    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    expect(turns).toHaveLength(1);
  });

  it("会话在人工接管中（agentPaused=true）不创建降级 Turn", async () => {
    const { conversationId, media } = await createImageConversation("handoff");
    await postgres.db
      .update(schema.mediaAssets)
      .set({
        status: "failed",
        errorCode: "retry_exhausted",
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAssets.mediaId, media.mediaId));
    await createHandoff(postgres.db, {
      conversationId,
      actorUserId: "test-actor",
      clientRequestId: randomUUID(),
      summary: "test handoff",
      sourceIp: "127.0.0.1",
    });

    const createdTurns = await createDegradedTurns(
      postgres.db,
      createLogger({ logLevel: "silent" }, "test"),
      readRuntimeSettings,
    );
    expect(createdTurns).toBe(0);
    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    expect(turns).toHaveLength(0);
  });

  it("联系人 agentEnabled=false 时不创建降级 Turn", async () => {
    const { conversationId, media, eventId } =
      await createImageConversation("disabled");
    await postgres.db
      .update(schema.mediaAssets)
      .set({
        status: "failed",
        errorCode: "retry_exhausted",
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAssets.mediaId, media.mediaId));
    const [conversation] = await postgres.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId))
      .limit(1);
    if (!conversation) throw new Error("conversation missing");
    await postgres.db
      .update(schema.contactProfiles)
      .set({ agentEnabled: false })
      .where(eq(schema.contactProfiles.contactId, conversation.contactId));

    const createdTurns = await createDegradedTurns(
      postgres.db,
      createLogger({ logLevel: "silent" }, "test"),
      readRuntimeSettings,
    );
    expect(createdTurns).toBe(0);
    void eventId;
  });

  it("视觉阶段停滞媒体超时恢复 → failed → 降级 Turn", async () => {
    const { conversationId, media } = await createImageConversation("stale");
    await postgres.db
      .update(schema.mediaAssets)
      .set({
        status: "processing",
        updatedAt: new Date(Date.now() - 20 * 60_000),
      })
      .where(eq(schema.mediaAssets.mediaId, media.mediaId));

    const stale = await recoverStaleMedia(
      postgres.db,
      createLogger({ logLevel: "silent" }, "test"),
    );
    expect(stale).toBe(1);
    const [after] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, media.mediaId));
    expect(after).toMatchObject({
      status: "failed",
      errorCode: "stale_timeout",
    });

    const createdTurns = await createDegradedTurns(
      postgres.db,
      createLogger({ logLevel: "silent" }, "test"),
      readRuntimeSettings,
    );
    expect(createdTurns).toBe(1);
    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    expect(turns).toHaveLength(1);
  });
});

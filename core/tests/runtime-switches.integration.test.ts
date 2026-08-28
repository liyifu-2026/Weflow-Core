/**
 * Phase 3 集成测试：knowledge / memory / vision 三个运行时开关的行为
 *
 * - memory OFF：不调度捕获（capture_states 不产生），不 recall（上下文无记忆）
 * - knowledge OFF：已规划的检索执行时返回空证据（disabled），不触发失败转人工
 * - vision OFF：视觉阶段媒体短路失败（vision_disabled）且图片消息幂等进入人工路径
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import { scheduleMemoryCaptureInTransaction } from "../modules/memory/application/schedule-memory-capture.js";
import { executeToolPlan } from "../modules/agent/application/execute-tool-plan.js";
import {
  createDegradedTurns,
  failMediaVisionDisabled,
} from "../infrastructure/redis/media-processing-dispatcher.js";
import {
  readRuntimeSettings,
  updateRuntimeSettings,
} from "../modules/operations/application/runtime-settings.js";
import { routeMediaToHuman } from "../modules/handoff/application/route-media-to-human.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const logger = createLogger({ logLevel: "silent" }, "runtime-switches-test");

integration("runtime switches（knowledge/memory/vision）", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const eventBase = `switches-${suffix}`;
  const created: { conversationId: string; contactId: string }[] = [];

  beforeAll(() => {
    postgres = createPostgres(databaseUrl ?? "", logger);
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
        .delete(schema.toolExecutions)
        .where(eq(schema.toolExecutions.conversationId, conversationId));
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
    await updateRuntimeSettings(postgres.db, logger, {
      actorUserId: "test",
      sourceIp: "127.0.0.1",
      patch: {
        agentEnabled: true,
        autoSendEnabled: true,
        knowledgeEnabled: true,
        memoryEnabled: true,
        visionEnabled: true,
      },
    });
    await postgres.close();
  });

  async function createConversation(tag: string, kind: "text" | "image") {
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
          kind,
          content: kind === "image" ? "[image]" : "你好",
          ...(kind === "image" ? { mediaRef: `media:${eventId}` } : {}),
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

  it("memory OFF：不调度捕获、不 recall", async () => {
    await updateRuntimeSettings(postgres.db, logger, {
      actorUserId: "test",
      sourceIp: "127.0.0.1",
      patch: { memoryEnabled: false },
    });
    const { conversationId } = await createConversation("mem", "text");
    const [message] = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .limit(1);
    if (!message) throw new Error("message missing");
    const contact = created[created.length - 1];
    if (!contact) throw new Error("contact fixture missing");
    // ingest 自身也会调度记忆捕获——memory OFF 时不应产生任何 capture_state
    await postgres.db.transaction(async (transaction) => {
      await scheduleMemoryCaptureInTransaction(transaction, {
        conversationId,
        contactId: contact.contactId,
        watermarkMessageId: message.messageId,
      });
    });
    const capture = await postgres.db
      .select()
      .from(schema.memoryCaptureStates)
      .where(eq(schema.memoryCaptureStates.conversationId, conversationId));
    expect(capture).toHaveLength(0);
  });

  it("knowledge OFF：已规划的检索返回空证据（disabled），不失败转人工", async () => {
    const { conversationId } = await createConversation("kb", "text");
    const [message] = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .limit(1);
    if (!message) throw new Error("message missing");
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.triggerMessageId, message.messageId))
      .limit(1);
    if (!turn) throw new Error("turn missing (ingest should create it)");
    await updateRuntimeSettings(postgres.db, logger, {
      actorUserId: "test",
      sourceIp: "127.0.0.1",
      patch: { knowledgeEnabled: false },
    });
    await postgres.db.insert(schema.toolExecutions).values({
      executionId: `exec-${suffix}`,
      turnId: turn.turnId,
      conversationId,
      toolName: "retrieve_knowledge",
      status: "planned",
      idempotencyKey: `exec-${suffix}`,
      arguments: { query: "设备故障" },
    });
    const result = await executeToolPlan(postgres.db, `exec-${suffix}`);
    expect(result.status).toBe("succeeded");
    const output = result.result as {
      disabled?: boolean;
      evidence?: unknown[];
    };
    expect(output.disabled).toBe(true);
    expect(output.evidence).toEqual([]);
  });

  it("vision OFF：视觉阶段媒体失败且图片消息幂等进入人工路径", async () => {
    const { conversationId } = await createConversation("vision", "image");
    const [media] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, conversationId))
      .limit(1);
    if (!media) throw new Error("media fixture missing");
    await postgres.db
      .update(schema.mediaAssets)
      .set({ status: "processing_queued", updatedAt: new Date() })
      .where(eq(schema.mediaAssets.mediaId, media.mediaId));
    await updateRuntimeSettings(postgres.db, logger, {
      actorUserId: "test",
      sourceIp: "127.0.0.1",
      patch: { visionEnabled: false },
    });

    const failed = await failMediaVisionDisabled(postgres.db, logger, (input) =>
      routeMediaToHuman(postgres.db, logger, input),
    );
    expect(failed).toBe(1);
    const [after] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, media.mediaId));
    expect(after).toMatchObject({
      status: "failed",
      errorCode: "vision_disabled",
    });
    // 图片进入人工路径（handoff 已创建），且不创建降级 Turn
    const [handoff] = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId));
    expect(handoff).toBeDefined();
    const degraded = await createDegradedTurns(
      postgres.db,
      logger,
      readRuntimeSettings,
    );
    expect(degraded).toBe(0);
    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    expect(turns).toHaveLength(0);
  });
});

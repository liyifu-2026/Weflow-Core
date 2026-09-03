/**
 * Phase 1 集成测试：合并窗口（Turn Admission）开关行为
 *
 * - mergeWindowEnabled ON：首条消息只登记不建 Turn；窗内续到新消息重置收窗；
 *   dispatcher 到期认领后合并建一个 Turn（trigger=窗内最后一条）
 * - mergeWindowEnabled OFF：逐条建 Turn（v1 行为逐字节一致）
 * - global-pause 消息不入窗口：任何客户消息不得无人处理的底线不被合并窗口吞掉
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import { processTurnAdmissions } from "../modules/conversations/application/process-turn-admissions.js";
import { updateRuntimeSettings } from "../modules/operations/application/runtime-settings.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const logger = createLogger({ logLevel: "silent" }, "turn-admission-test");

integration("merge window（合并窗口开关行为）", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const eventBase = `admission-${suffix}`;
  const created: { conversationId: string; contactId: string }[] = [];

  beforeAll(() => {
    postgres = createPostgres(databaseUrl ?? "", logger);
  });

  afterAll(async () => {
    for (const { conversationId, contactId } of created) {
      // FK 依赖顺序：登记/记忆窗口 → turns → messages → conversations → contacts
      await postgres.db
        .delete(schema.turnAdmissionStates)
        .where(
          eq(schema.turnAdmissionStates.conversationId, conversationId),
        );
      await postgres.db
        .delete(schema.memoryCaptureStates)
        .where(
          eq(schema.memoryCaptureStates.conversationId, conversationId),
        );
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
    }
    await updateRuntimeSettings(postgres.db, logger, {
      actorUserId: "test",
      sourceIp: "127.0.0.1",
      patch: { mergeWindowEnabled: false },
    });
    await postgres.close();
  });

  /**
   * 白名单模式（migration 0060）：ingest 只为 agentEnabled=true 的
   * 联系人建 Turn/登记窗口；此 helper 幂等预建联系人与会话不存在时
   * 由 ingest 自动创建的事实保持一致。
   */
  async function ensureWhitelistedContact(contactId: string, ref: string) {
    await postgres.db
      .insert(schema.contactProfiles)
      .values({
        contactId,
        channel: "channel",
        channelContactId: ref,
        agentEnabled: true,
      })
      .onConflictDoNothing();
  }

  function admissionEvent(tag: string, seq: number, text: string) {
    const eventId = `${eventBase}-${tag}-e${seq}`;
    return {
      cursor: String(seq),
      eventId,
      conversationRef: `${eventBase}-${tag}`,
      channelMessageId: `channel-${eventId}`,
      senderRef: "wxid_friend",
      kind: "text" as const,
      content: text,
      occurredAt: "2026-09-03T00:00:00.000Z",
      observedAt: "2026-09-03T00:00:01.000Z",
      isSelf: false,
    };
  }

  async function ingestOne(
    tag: string,
    seq: number,
    text: string,
  ): Promise<{ conversationId: string }> {
    const conversationId = `channel:${eventBase}-${tag}`;
    await ensureWhitelistedContact(
      `contact:channel:${eventBase}-${tag}`,
      `${eventBase}-${tag}`,
    );
    await ingestChannelEvents(
      postgres.db,
      [admissionEvent(tag, seq, text)],
      String(seq),
    );
    const [conversation] = await postgres.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId))
      .limit(1);
    if (!conversation) throw new Error("conversation fixture missing");
    if (!created.some((c) => c.conversationId === conversationId)) {
      created.push({ conversationId, contactId: conversation.contactId });
    }
    return { conversationId };
  }

  async function turnCount(conversationId: string): Promise<number> {
    const rows = await postgres.db
      .select({ turnId: schema.agentTurns.turnId })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    return rows.length;
  }

  it("开关 OFF：逐条建 Turn（v1 行为），不产生合并窗口登记", async () => {
    await updateRuntimeSettings(postgres.db, logger, {
      actorUserId: "test",
      sourceIp: "127.0.0.1",
      patch: { mergeWindowEnabled: false },
    });
    const { conversationId } = await ingestOne("off", 1, "在吗");
    await ingestOne("off", 2, "我的订单");
    expect(await turnCount(conversationId)).toBe(2);
    const states = await postgres.db
      .select()
      .from(schema.turnAdmissionStates)
      .where(eq(schema.turnAdmissionStates.conversationId, conversationId));
    expect(states).toHaveLength(0);
  });

  it("开关 ON：首条消息只登记不建 Turn；到期处理前不建、处理后建 1 个", async () => {
    await updateRuntimeSettings(postgres.db, logger, {
      actorUserId: "test",
      sourceIp: "127.0.0.1",
      patch: { mergeWindowEnabled: true },
    });
    const { conversationId } = await ingestOne("on", 1, "在吗");
    expect(await turnCount(conversationId)).toBe(0);
    const [state] = await postgres.db
      .select()
      .from(schema.turnAdmissionStates)
      .where(eq(schema.turnAdmissionStates.conversationId, conversationId));
    if (!state) throw new Error("admission state missing");
    expect(state.status).toBe("scheduled");
    expect(state.messageCount).toBe(1);
    // 模拟窗口到期：把 scheduledAt 拨到过去，跑 dispatcher
    await postgres.db
      .update(schema.turnAdmissionStates)
      .set({ scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(schema.turnAdmissionStates.conversationId, conversationId));
    const processed = await processTurnAdmissions(postgres.db, logger);
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(await turnCount(conversationId)).toBe(1);
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    if (!turn) throw new Error("turn missing");
    const [lastMessage] = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.direction, "inbound"),
        ),
      )
      .orderBy(schema.messages.occurredAt);
    if (!lastMessage) throw new Error("last message missing");
    expect(turn.triggerMessageId).toBe(lastMessage.messageId);
    // 处理完成后登记行不再可重复认领
    const [after] = await postgres.db
      .select()
      .from(schema.turnAdmissionStates)
      .where(eq(schema.turnAdmissionStates.conversationId, conversationId));
    if (!after) throw new Error("state missing after dispatch");
    expect(after.status).toBe("done");
  });

  it("开关 ON：窗内连发多条只建 1 个 Turn（trigger=最后一条）", async () => {
    const { conversationId } = await ingestOne("burst", 1, "在吗");
    await ingestOne("burst", 2, "我的订单");
    await ingestOne("burst", 3, "退款了怎么还没到。");
    expect(await turnCount(conversationId)).toBe(0);
    await postgres.db
      .update(schema.turnAdmissionStates)
      .set({ scheduledAt: new Date(Date.now() - 1000) })
      .where(eq(schema.turnAdmissionStates.conversationId, conversationId));
    await processTurnAdmissions(postgres.db, logger);
    expect(await turnCount(conversationId)).toBe(1);
    const [turn] = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    if (!turn) throw new Error("turn missing");
    const [state] = await postgres.db
      .select()
      .from(schema.turnAdmissionStates)
      .where(eq(schema.turnAdmissionStates.conversationId, conversationId));
    if (!state) throw new Error("state missing");
    expect(state.messageCount).toBe(3);
    expect(turn.triggerMessageId).toBe(state.lastMessageId);
  });
});

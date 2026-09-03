/**
 * Phase 3 集成测试：会话唤醒（wait 决策 → session_wakes → dispatcher 消费）
 *
 * 不走完整 LLM 链路（模型相关行为已有单元/契约层覆盖），这里验证
 * 持久化契约：scheduleSessionWake 落行、到点被认领、消费置 done、
 * nudge_text 随行携带（直发由 outbound 层执行，属既有链路）。
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import {
  claimDueSessionWakes,
  markWakeDone,
  scheduleSessionWake,
} from "../modules/agent/application/session-wake.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const logger = createLogger({ logLevel: "silent" }, "session-wake-test");

integration("session wake（会话唤醒持久化契约）", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationId = `channel:wake-${suffix}`;
  const contactId = `contact:channel:wake-${suffix}`;
  const turnId = `turn:wake-${suffix}`;
  const messageId = `wake-message:${suffix}`;

  beforeAll(async () => {
    postgres = createPostgres(databaseUrl ?? "", logger);
    await postgres.db
      .insert(schema.contactProfiles)
      .values({
        contactId,
        channel: "channel",
        channelContactId: `wake-${suffix}`,
        agentEnabled: true,
      })
      .onConflictDoNothing();
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `wake-${suffix}`,
    });
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      actorId: contactId,
      contentType: "text",
      channelType: 1,
      text: "在吗",
      processingState: "received",
      idempotencyKey: messageId,
      occurredAt: new Date(),
      traceId: messageId,
    });
    await postgres.db.insert(schema.agentTurns).values({
      turnId,
      triggerMessageId: messageId,
      conversationId,
      status: "completed",
      traceId: `wake-trace:${suffix}`,
    });
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.sessionWakes)
      .where(eq(schema.sessionWakes.conversationId, conversationId));
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

  it("wait 决策落 wake 行；同 turn 重复决策覆盖旧计划", async () => {
    const now = new Date();
    await scheduleSessionWake(postgres.db, {
      conversationId,
      turnId,
      waitMs: 60_000,
      nudgeText: "第一版提醒",
      now,
    });
    // 同 turn 再次决策（例如模型改了等待时长）→ 覆盖
    await scheduleSessionWake(postgres.db, {
      conversationId,
      turnId,
      waitMs: 300_000,
      nudgeText: "您先忙，有问题随时叫我",
      now,
    });
    const [row] = await postgres.db
      .select()
      .from(schema.sessionWakes)
      .where(eq(schema.sessionWakes.turnId, turnId));
    if (!row) throw new Error("wake row missing");
    expect(row.nudgeText).toBe("您先忙，有问题随时叫我");
    expect(row.wakeAt.getTime()).toBe(now.getTime() + 300_000);
  });

  it("到期唤醒被认领、消费置 done；未到期的不会被扫出", async () => {
    const past = new Date(Date.now() - 5_000);
    await scheduleSessionWake(postgres.db, {
      conversationId,
      turnId,
      waitMs: 1,
      now: past,
    });
    // 另一个未来的 wake（借第二条 turn）不应被扫出
    const turn2Id = `${turnId}:second`;
    const messageId2 = `${messageId}:second`;
    await postgres.db.insert(schema.messages).values({
      messageId: messageId2,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      actorId: contactId,
      contentType: "text",
      channelType: 1,
      text: "第二条",
      processingState: "received",
      idempotencyKey: messageId2,
      occurredAt: new Date(),
      traceId: messageId2,
    });
    await postgres.db.insert(schema.agentTurns).values({
      turnId: turn2Id,
      triggerMessageId: messageId2,
      conversationId,
      status: "completed",
      traceId: `wake-trace2:${suffix}`,
    });
    await scheduleSessionWake(postgres.db, {
      conversationId,
      turnId: turn2Id,
      waitMs: 600_000,
      now: new Date(),
    });
    const due = await claimDueSessionWakes(postgres.db, new Date());
    const ours = due.filter((w) => w.conversationId === conversationId);
    expect(ours).toHaveLength(1);
    expect(ours[0]?.turnId).toBe(turnId);
    await markWakeDone(postgres.db, ours[0]!.wakeId);
    const [after] = await postgres.db
      .select()
      .from(schema.sessionWakes)
      .where(eq(schema.sessionWakes.turnId, turnId));
    expect(after?.status).toBe("done");
    const dueAgain = await claimDueSessionWakes(postgres.db, new Date());
    expect(dueAgain.filter((w) => w.turnId === turnId)).toHaveLength(0);
  });
});

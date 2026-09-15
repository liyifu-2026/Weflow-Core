/**
 * findNewerActiveTurnIds 状态过滤回归（2026-09-06 Leaif 事故）：
 * 合并窗口留下的幸存 turn，不得再被一个"更新的终态 turn"处决——
 * 否则同会话双双 superseded、客户收不到任何回复。
 *
 * （曾另有一份同谓词的 hasNewerAgentTurn 死副本，仅测试引用、生产零
 * 消费，2026-09-09 删除；本回归现在直接钉住在用的吸收查询。）
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { findNewerActiveTurnIds } from "../modules/agent/application/turn-utils.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("findNewerActiveTurnIds terminal-status filter", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationId = `channel:newer-turn-${suffix}`;
  const contactId = `contact:channel:newer-turn-${suffix}`;
  const oldMessageId = `newer-turn-msg-old-${suffix}`;
  const newMessageId = `newer-turn-msg-new-${suffix}`;
  const oldTurnId = `turn:newer-turn-old-${suffix}`;
  const newTurnId = `turn:newer-turn-new-${suffix}`;

  const insertMessage = (messageId: string, occurredAt: Date) =>
    postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text: messageId,
      processingState: "received",
      idempotencyKey: messageId,
      occurredAt,
      traceId: messageId,
    });

  const insertTurn = (turnId: string, triggerMessageId: string, status: string) =>
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
      createLogger({ logLevel: "silent" }, "newer-turn-test"),
    );
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `newer-turn-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `newer-turn-${suffix}`,
    });
    await insertMessage(oldMessageId, new Date("2026-09-06T14:21:36.000Z"));
    await insertMessage(newMessageId, new Date("2026-09-06T14:21:42.000Z"));
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

  it("更新的 turn 已是终态（superseded）时不再处决幸存者", async () => {
    // 事故形状：旧触发 turn（本 turn）+ 新触发 turn 已被合并标记 superseded
    await insertTurn(oldTurnId, oldMessageId, "running");
    await insertTurn(newTurnId, newMessageId, "superseded");

    expect(
      await findNewerActiveTurnIds(postgres.db, {
        turnId: oldTurnId,
        conversationId,
        triggerMessageId: oldMessageId,
      }),
    ).toEqual([]);
  });

  it("更新的 turn 仍在排队/执行时正常判定为更新（既有语义）", async () => {
    expect(
      await findNewerActiveTurnIds(postgres.db, {
        turnId: oldTurnId,
        conversationId,
        triggerMessageId: oldMessageId,
      }),
    ).toEqual([]); // newTurnId 仍为 superseded，先验证基线

    await postgres.db
      .update(schema.agentTurns)
      .set({ status: "queued" })
      .where(eq(schema.agentTurns.turnId, newTurnId));

    expect(
      await findNewerActiveTurnIds(postgres.db, {
        turnId: oldTurnId,
        conversationId,
        triggerMessageId: oldMessageId,
      }),
    ).toEqual([newTurnId]);
  });
});

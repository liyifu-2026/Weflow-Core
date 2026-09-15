import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { processHandoffReminders } from "../modules/handoff/application/handoff-reminder.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("handoff reminder", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const cycleStale = `handoff-cycle:reminder-stale-${suffix}`;
  const cycleFresh = `handoff-cycle:reminder-fresh-${suffix}`;
  const cycleClaimed = `handoff-cycle:reminder-claimed-${suffix}`;
  const convStale = `channel:handoff-reminder-stale-${suffix}`;
  const convFresh = `channel:handoff-reminder-fresh-${suffix}`;
  const convClaimed = `channel:handoff-reminder-claimed-${suffix}`;
  const contactStale = `contact:${convStale}`;
  const contactFresh = `contact:${convFresh}`;
  const contactClaimed = `contact:${convClaimed}`;
  const reminderText = "已帮你转人工客服了，稍等一下哈。";

  async function seedHandoff(input: {
    conversationId: string;
    contactId: string;
    cycleId: string;
    status: string;
    createdAt: Date;
  }) {
    await postgres.db.insert(schema.contactProfiles).values({
      contactId: input.contactId,
      channel: "channel",
      channelContactId: input.contactId,
      agentEnabled: true,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId: input.conversationId,
      contactId: input.contactId,
      channel: "channel",
      channelConversationId: input.conversationId,
    });
    await postgres.db.insert(schema.handoffCycles).values({
      cycleId: input.cycleId,
      conversationId: input.conversationId,
      status: input.status,
      reason: "test: handoff reminder",
      createdByUserId: "system-agent",
      createdAt: input.createdAt,
    });
    await postgres.db.insert(schema.handoffStates).values({
      conversationId: input.conversationId,
      cycleId: input.cycleId,
      status: input.status,
      reason: "test: handoff reminder",
      agentPaused: true,
      createdByUserId: "system-agent",
      createdAt: input.createdAt,
    });
  }

  async function cleanupHandoff(input: {
    conversationId: string;
    contactId: string;
    cycleId: string;
  }) {
    await postgres.db
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, input.conversationId));
    await postgres.db
      .delete(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId));
    await postgres.db
      .delete(schema.handoffCycles)
      .where(eq(schema.handoffCycles.cycleId, input.cycleId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, input.conversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, input.contactId));
  }

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "handoff-reminder-test"),
    );
    const stale = new Date(Date.now() - 10 * 60_000);
    const fresh = new Date(Date.now() - 30_000);
    await seedHandoff({
      conversationId: convStale,
      contactId: contactStale,
      cycleId: cycleStale,
      status: "pending",
      createdAt: stale,
    });
    await seedHandoff({
      conversationId: convFresh,
      contactId: contactFresh,
      cycleId: cycleFresh,
      status: "pending",
      createdAt: fresh,
    });
    await seedHandoff({
      conversationId: convClaimed,
      contactId: contactClaimed,
      cycleId: cycleClaimed,
      status: "in_progress",
      createdAt: stale,
    });
  });

  afterAll(async () => {
    await cleanupHandoff({
      conversationId: convStale,
      contactId: contactStale,
      cycleId: cycleStale,
    });
    await cleanupHandoff({
      conversationId: convFresh,
      contactId: contactFresh,
      cycleId: cycleFresh,
    });
    await cleanupHandoff({
      conversationId: convClaimed,
      contactId: contactClaimed,
      cycleId: cycleClaimed,
    });
    await postgres.close();
  });

  it("pending 超时未认领：代发一条 system 提醒；重复执行幂等", async () => {
    // 共享测试库存在其他套件遗留的 pending 行：只对本测试会话断言，
    // 不依赖全库发送计数。
    await processHandoffReminders(postgres.db, {
      reminderText,
      delayMs: 120_000,
    });

    const messages = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, convStale));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      actorType: "system",
      sendState: "pending",
      text: reminderText,
      messageId: `handoff-reminder:${cycleStale}`,
    });

    // 第二次执行：确定性 messageId 命中冲突，不再重复发送
    await processHandoffReminders(postgres.db, {
      reminderText,
      delayMs: 120_000,
    });
    const after = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, convStale));
    expect(after).toHaveLength(1);
  });

  it("pending 未超时不提醒；已认领（in_progress）不提醒", async () => {
    await processHandoffReminders(postgres.db, {
      reminderText,
      delayMs: 120_000,
    });
    for (const conversationId of [convFresh, convClaimed]) {
      const messages = await postgres.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversationId));
      expect(messages).toHaveLength(0);
    }
  });

  it("文案为空（功能关闭）：不做任何发送", async () => {
    const sent = await processHandoffReminders(postgres.db, {
      reminderText: "",
      delayMs: 120_000,
    });
    expect(sent).toBe(0);
    const messages = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, convStale));
    // 此前用例发送的那条仍在，但没有新增
    expect(messages).toHaveLength(1);
  });
});

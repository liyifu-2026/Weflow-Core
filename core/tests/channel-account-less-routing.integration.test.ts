/**
 * Phase 8 集成回归测试：account-less 事件路由防护（ADR-0005 数据一致性）
 *
 * 背景：历史 Channel Host 曾因未注入 WECHAT_ACCOUNT 而发出不带 account 的事件，
 * Core 把 account 缺省归一为 "default"，导致同一客户被拆出 `channel:<ref>` 孤儿会话，
 * 历史被一分为二（真实事故：wxid_r464u9kms3si12 出现 42+3 两条会话）。
 *
 * 修复：ingest 遇到 account 缺省（default）时，若该客户已在某个真实账号下存在会话，
 * 则路由进既有账号会话，避免再造 default 孤儿、拆散历史。
 *
 * 本测试仅在 TEST_DATABASE_URL 存在时运行，绝不对线上库产生副作用。
 */
import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import { createPostgres, type Postgres } from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import { contactIdForChannel } from "../modules/contacts/application/contact-profile-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const logger = createLogger({ logLevel: "silent" }, "account-less-routing-test");

const CHANNEL_KIND = "channel";

integration("account-less 事件路由防护（ADR-0005 数据一致性）", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const base = `acctless-${suffix}`;
  const sourceRef = `wxid_${base}`;
  const account = `wxid_acc_${base}`;
  const mainConversationId = `${CHANNEL_KIND}:${account}:${sourceRef}`;
  const mainContactId = contactIdForChannel(CHANNEL_KIND, sourceRef, account);
  const defaultConversationId = `${CHANNEL_KIND}:${sourceRef}`;
  const created: { conversationId: string; contactId: string }[] = [];

  beforeAll(() => {
    postgres = createPostgres(databaseUrl ?? "", logger);
  });

  afterAll(async () => {
    try {
      const ids = new Set<string>();
      for (const { conversationId, contactId } of created) {
        ids.add(conversationId);
        ids.add(contactId);
      }
      for (const conversationId of ids) {
        if (conversationId.startsWith("contact:")) continue;
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
      }
      await postgres.db
        .delete(schema.contactProfiles)
        .where(eq(schema.contactProfiles.contactId, mainContactId));
      await postgres.db
        .delete(schema.contactProfiles)
        .where(eq(schema.contactProfiles.contactId, contactIdForChannel(CHANNEL_KIND, sourceRef)));
    } finally {
      await postgres.close();
    }
  });

  it("account-less 事件路由进既有真实账号会话，而不是再造 default 孤儿", async () => {
    // 1) 先生成客户在真实账号下的会话（正常路径）
    await ingestChannelEvents(
      postgres.db,
      [
      {
        cursor: "1",
        eventId: `${base}-with-account-1`,
        conversationRef: sourceRef,
        account,
        channelMessageId: `channel-${base}-1`,
        senderRef: sourceRef,
        kind: "text",
        content: "第一条（带账号）",
        occurredAt: "2026-08-27T00:00:00.000Z",
        observedAt: "2026-08-27T00:00:01.000Z",
        isSelf: false,
      },
      ],
      "1",
      logger,
    );
    created.push({ conversationId: mainConversationId, contactId: mainContactId });

    // 2) 再来一条不带 account 的事件（历史 host 缺账号），应被防护路由进主会话
    await ingestChannelEvents(
      postgres.db,
      [
      {
        cursor: "2",
        eventId: `${base}-no-account-1`,
        conversationRef: sourceRef,
        channelMessageId: `channel-${base}-2`,
        senderRef: sourceRef,
        kind: "text",
        content: "第二条（缺账号）",
        occurredAt: "2026-08-27T00:00:02.000Z",
        observedAt: "2026-08-27T00:00:03.000Z",
        isSelf: false,
      },
      ],
      "2",
      logger,
    );
    created.push({ conversationId: mainConversationId, contactId: mainContactId });

    // 3) 断言：缺账号那条消息落在主会话，没有新增 default 孤儿会话
    const mainMsgs = await postgres.db
      .select({ text: schema.messages.text })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, mainConversationId))
      .orderBy(schema.messages.occurredAt);
    expect(mainMsgs.map((m) => m.text)).toEqual(["第一条（带账号）", "第二条（缺账号）"]);

    const orphanConv = await postgres.db
      .select({ conversationId: schema.conversations.conversationId })
      .from(schema.conversations)
      .where(eq(schema.conversations.conversationId, defaultConversationId));
    expect(orphanConv).toHaveLength(0);

    const orphanMsgs = await postgres.db
      .select({ messageId: schema.messages.messageId })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, defaultConversationId));
    expect(orphanMsgs).toHaveLength(0);

    // 4) 客户始终只有一条会话（channel_conversation_id=sourceRef）
    const all = await postgres.db
      .select({ conversationId: schema.conversations.conversationId })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.channel, CHANNEL_KIND),
          eq(schema.conversations.channelConversationId, sourceRef),
          ne(schema.conversations.channelAccount, "default"),
        ),
      );
    expect(all).toHaveLength(1);
    expect(all[0]!.conversationId).toBe(mainConversationId);
  });
});

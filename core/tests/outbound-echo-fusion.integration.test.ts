/**
 * 出站媒体自回声融合集成回归测试。
 *
 * 场景：manual reply 媒体消息（ct=media）发送成功后，微信 DB 自消息行被
 * Host 捕获为 isSelf image/file 事件回流。融合后：
 *  - 不插入重复回声行（单气泡）
 *  - manual 行升级 confirmed + 回填 channelMessageId
 * 匹配不到候选（超窗/kind 不匹配/终态）时回声行独立插入（保底可见）。
 *
 * 本测试仅在 TEST_DATABASE_URL 存在时运行，绝不对线上库产生副作用。
 */
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import { createPostgres, type Postgres } from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import { contactIdForChannel } from "../modules/contacts/application/contact-profile-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const logger = createLogger({ logLevel: "silent" }, "echo-fusion-test");

const CHANNEL_KIND = "channel";

integration("出站媒体自回声融合", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const base = `echo-${suffix}`;
  const sourceRef = `wxid_${base}`;
  const account = `wxid_acc_${base}`;
  const conversationId = `${CHANNEL_KIND}:${account}:${sourceRef}`;
  const contactId = contactIdForChannel(CHANNEL_KIND, sourceRef, account);
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
      for (const id of ids) {
        if (id.startsWith("contact:")) continue;
        await postgres.db
          .delete(schema.agentTurns)
          .where(eq(schema.agentTurns.conversationId, id));
        await postgres.db
          .delete(schema.memoryCaptureStates)
          .where(eq(schema.memoryCaptureStates.conversationId, id));
        await postgres.db
          .delete(schema.handoffStates)
          .where(eq(schema.handoffStates.conversationId, id));
        await postgres.db
          .delete(schema.handoffEvents)
          .where(eq(schema.handoffEvents.conversationId, id));
        await postgres.db
          .delete(schema.handoffCycles)
          .where(eq(schema.handoffCycles.conversationId, id));
        await postgres.db
          .delete(schema.notificationOutbox)
          .where(eq(schema.notificationOutbox.conversationId, id));
        await postgres.db
          .delete(schema.mediaAssets)
          .where(eq(schema.mediaAssets.conversationId, id));
        await postgres.db
          .delete(schema.messages)
          .where(eq(schema.messages.conversationId, id));
        await postgres.db
          .delete(schema.conversations)
          .where(eq(schema.conversations.conversationId, id));
      }
      await postgres.db
        .delete(schema.contactProfiles)
        .where(eq(schema.contactProfiles.contactId, contactId));
    } finally {
      await postgres.close();
    }
  });

  async function seedManualMediaRow(
    label: string,
    kind: "image" | "file",
    occurredAt: Date,
    sendState: string,
  ): Promise<string> {
    const messageId = `manual-message:${base}-${label}`;
    // ingest 会 upsert contact_profiles；直接种子时必须先建联系人（FK）
    await postgres.db
      .insert(schema.contactProfiles)
      .values({
        contactId,
        channel: CHANNEL_KIND,
        channelAccount: account,
        channelContactId: sourceRef,
      })
      .onConflictDoNothing();
    await postgres.db
      .insert(schema.conversations)
      .values({
        conversationId,
        contactId,
        channel: CHANNEL_KIND,
        channelAccount: account,
        channelConversationId: sourceRef,
      })
      .onConflictDoNothing();
    await postgres.db
      .insert(schema.messages)
      .values({
        messageId,
        conversationId,
        channelEventId: null,
        channelMessageId: null,
        direction: "outbound",
        actorType: "user",
        contentType: "media",
        channelType: 1,
        text: "",
        isSelf: true,
        processingState: "not_applicable",
        sendState,
        idempotencyKey: `manual:${base}-${label}`,
        occurredAt,
        traceId: `test:${label}`,
      })
      .onConflictDoNothing();
    await postgres.db
      .insert(schema.mediaAssets)
      .values({
        mediaId: `media:${base}-${label}`,
        messageId,
        conversationId,
        sourceConversationId: `test:${label}`,
        kind,
        status: "ready",
      })
      .onConflictDoNothing();
    created.push({ conversationId, contactId });
    return messageId;
  }

  function echoEvent(
    label: string,
    kind: "image" | "file",
    atSeconds: number,
  ) {
    return {
      cursor: `${base}-cursor-${label}`,
      eventId: `${base}-echo-${label}`,
      conversationRef: sourceRef,
      account,
      channelMessageId: `${base}-chmsg-${label}`,
      senderRef: account,
      kind,
      content: kind === "image" ? "[image]" : "doc.pdf",
      mediaRef: `wechat-media:v1:${label}`,
      occurredAt: new Date(atSeconds * 1000).toISOString(),
      observedAt: new Date(atSeconds * 1000).toISOString(),
      isSelf: true,
    };
  }

  it("image 回声融合：不插重复行，manual 行 confirmed + channelMessageId 回填", async () => {
    const sendAt = new Date("2026-08-31T08:00:00.000Z");
    const messageId = await seedManualMediaRow("img1", "image", sendAt, "confirmed");
    // Host 轮询回声：发送后 ~8s（GUI 发送 + 微信 DB 落库延迟）
    const echoAt = Math.floor(sendAt.getTime() / 1000) + 8;
    await ingestChannelEvents(postgres.db, [echoEvent("e1", "image", echoAt)], "1", logger);

    const rows = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(schema.messages.occurredAt);
    // 只有一条：manual 行被融合，无独立回声行
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messageId).toBe(messageId);
    expect(rows[0]!.channelMessageId).toBe(`${base}-chmsg-e1`);
    expect(rows[0]!.sendState).toBe("confirmed");
    expect(rows[0]!.contentType).toBe("media");
  });

  it("file 回声融合：file 对 file，不误配 image 行", async () => {
    const sendAt = new Date("2026-08-31T08:05:00.000Z");
    const imgId = await seedManualMediaRow("img2", "image", sendAt, "confirmed");
    const fileId = await seedManualMediaRow("file1", "file", sendAt, "confirmed");
    const echoAt = Math.floor(sendAt.getTime() / 1000) + 10;
    await ingestChannelEvents(postgres.db, [echoEvent("e2", "file", echoAt)], "2", logger);

    const fileRow = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, fileId))
      .limit(1);
    expect(fileRow[0]!.channelMessageId).toBe(`${base}-chmsg-e2`);
    // image 行未被误绑
    const imgRow = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, imgId))
      .limit(1);
    expect(imgRow[0]!.channelMessageId).toBeNull();
  });

  it("kind 不匹配（file 回声遇 image 待确认行）：回声独立成行，不误绑", async () => {
    const sendAt = new Date("2026-08-31T08:10:00.000Z");
    await seedManualMediaRow("img3", "image", sendAt, "confirmed");
    const echoAt = Math.floor(sendAt.getTime() / 1000) + 6;
    await ingestChannelEvents(postgres.db, [echoEvent("e3", "file", echoAt)], "3", logger);

    const echoRows = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelEventId, `${base}-echo-e3`));
    expect(echoRows).toHaveLength(1);
    expect(echoRows[0]!.contentType).toBe("file");
    expect(echoRows[0]!.actorType).toBe("system");
  });

  it("超窗（回声晚于所有候选行 11 分钟）：独立成行", async () => {
    // 该用例共享同一会话；发送时间取所有已有种子行最晚之后 + 11 分钟，
    // 确保窗口内没有任何 manual 候选行
    const latest = await postgres.db
      .select({ occurredAt: schema.messages.occurredAt })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(desc(schema.messages.occurredAt))
      .limit(1);
    const sendAt = latest[0]!.occurredAt;
    const echoAt = Math.floor(sendAt.getTime() / 1000) + 11 * 60;
    await ingestChannelEvents(postgres.db, [echoEvent("e4", "image", echoAt)], "4", logger);

    const echoRows = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelEventId, `${base}-echo-e4`));
    expect(echoRows).toHaveLength(1);
  });

  it("failed 终态行不被迟来回声复活；unknown 行可被融合", async () => {
    const sendAt = new Date("2026-08-31T08:20:00.000Z");
    const failedId = await seedManualMediaRow("img5", "image", sendAt, "failed");
    const unknownId = await seedManualMediaRow("img6", "image", sendAt, "unknown");
    const echoAt = Math.floor(sendAt.getTime() / 1000) + 9;
    await ingestChannelEvents(postgres.db, [echoEvent("e5", "image", echoAt)], "5", logger);

    const failedRow = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, failedId))
      .limit(1);
    expect(failedRow[0]!.channelMessageId).toBeNull(); // 未被绑定
    expect(failedRow[0]!.sendState).toBe("failed");

    const unknownRow = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, unknownId))
      .limit(1);
    // FIFO 取最早候选 = unknown 行（failed 被排除）
    expect(unknownRow[0]!.channelMessageId).toBe(`${base}-chmsg-e5`);
    expect(unknownRow[0]!.sendState).toBe("confirmed");
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStorage } from "../infrastructure/file_storage/local-file-storage.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import type { ChannelMediaSource } from "../modules/channel/contracts/channel-media-source.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import { syncChannelMedia } from "../modules/media/application/sync-channel-media.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Channel Host inbound voice media", () => {
  let postgres: Postgres;
  let root: string;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationRef = `channel-voice-${suffix}`;
  const conversationId = `channel:${conversationRef}`;
  const contactId = `contact:channel:${conversationRef}`;
  const silkBytes = new Uint8Array([0x02, 0x23, 0x21, 0x53]);
  const mediaRefFor = (tag: string) => `wechat-media:v1:${suffix}-${tag}`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "weflow-channel-voice-"));
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "channel-voice-media-test"),
    );
  });

  afterAll(async () => {
    const assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, conversationId));
    const fileIds = assets
      .map((asset) => asset.originalFileId)
      .filter((fileId): fileId is string => Boolean(fileId));
    await postgres.db
      .delete(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, conversationId));
    for (const fileId of fileIds) {
      await postgres.db
        .delete(schema.storedFiles)
        .where(eq(schema.storedFiles.fileId, fileId));
    }
    await postgres.db
      .delete(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(eq(schema.memoryCaptureStates.conversationId, conversationId));
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
    await rm(root, { recursive: true, force: true });
  });

  it("voice event with transcript stores text and creates the Agent Turn directly", async () => {
    const eventId = `channel:${conversationRef}:voice-text`;
    const messageId = `channel:${eventId}`;
    await ingestChannelEvents(
      postgres.db,
      [
        {
          eventId,
          cursor: "10",
          conversationRef,
          channelMessageId: "opaque-voice-1",
          senderRef: "wxid-contact",
          kind: "voice",
          content: "你好，请帮我查一下订单",
          mediaRef: mediaRefFor("with-text"),
          mimeType: "audio/x-silk",
          occurredAt: "2026-08-23T00:00:00Z",
          observedAt: "2026-08-23T00:00:01Z",
          isSelf: false,
        },
      ],
      "10",
    );

    const messages = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, messageId));
    expect(messages).toHaveLength(1);
    // 转写文本直接作为正文：Console/Mobile 显示文本，Agent 用文本理解
    expect(messages[0]).toMatchObject({
      contentType: "voice",
      text: "你好，请帮我查一下订单",
    });

    const assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    expect(assets).toHaveLength(0);

    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.triggerMessageId, messageId));
    expect(turns).toHaveLength(1);
  });

  it("voice event without transcript queues the asset and waits for ASR", async () => {
    const eventId = `channel:${conversationRef}:voice-silk`;
    const messageId = `channel:${eventId}`;
    const mediaRef = mediaRefFor("no-text");
    await ingestChannelEvents(
      postgres.db,
      [
        {
          eventId,
          cursor: "11",
          conversationRef,
          channelMessageId: "opaque-voice-2",
          senderRef: "wxid-contact",
          kind: "voice",
          content: "",
          mediaRef,
          mimeType: "audio/x-silk",
          occurredAt: "2026-08-23T00:01:00Z",
          observedAt: "2026-08-23T00:01:01Z",
          isSelf: false,
        },
      ],
      "11",
    );

    const messages = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, messageId));
    expect(messages[0]).toMatchObject({ contentType: "voice", text: "" });

    const assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      sourceMediaRef: mediaRef,
      kind: "voice",
      status: "queued",
    });

    // 未拿到转写前不得建 Turn（等 ASR 或降级路径）
    const prematureTurns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.triggerMessageId, messageId));
    expect(prematureTurns).toHaveLength(0);

    const storage = new LocalFileStorage(root);
    const source: ChannelMediaSource = {
      resolveImage: () => {
        throw new Error("voice assets must not use resolveImage");
      },
      resolveFile: () => {
        throw new Error("voice assets must not use resolveFile");
      },
      resolveAudio: (ref) => {
        expect(ref).toBe(mediaRef);
        const body = new Response(silkBytes).body;
        if (!body) throw new Error("audio response body is unavailable");
        return Promise.resolve({
          state: "ready",
          body,
          mimeType: "audio/x-silk",
        });
      },
    };

    await syncChannelMedia(postgres.db, storage, source);

    const synced = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    // 语音下载后进入转写阶段（processing_queued），由 dispatcher 派发 ASR
    expect(synced[0]).toMatchObject({ status: "processing_queued" });
    const file = await postgres.db
      .select()
      .from(schema.storedFiles)
      .where(eq(schema.storedFiles.fileId, synced[0]?.originalFileId ?? ""));
    expect(file).toHaveLength(1);
    expect(file[0]?.mimeType).toBe("audio/x-silk");
    expect(file[0]?.originalName).toMatch(/\.silk$/);
    await expect(
      readFile(join(root, file[0]?.storageKey ?? "")),
    ).resolves.toEqual(Buffer.from(silkBytes));
  });
});

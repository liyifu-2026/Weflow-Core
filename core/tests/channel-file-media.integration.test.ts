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

integration("Channel Host inbound file media", () => {
  let postgres: Postgres;
  let root: string;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationRef = `channel-file-${suffix}`;
  const conversationId = `channel:${conversationRef}`;
  const contactId = `contact:channel:${conversationRef}`;
  const eventId = `channel:${conversationRef}:file-1`;
  const messageId = `channel:${eventId}`;
  const mediaRef = `wechat-media:v1:${suffix}`;
  const fileName = `季度报告-${suffix}.pdf`;
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "weflow-channel-file-"));
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "channel-file-media-test"),
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
    await postgres.db
      .delete(schema.channelCursors)
      .where(eq(schema.channelCursors.source, "channel-host"));
    await postgres.close();
    await rm(root, { recursive: true, force: true });
  });

  it("persists a file event and lands the attachment ready without vision", async () => {
    await ingestChannelEvents(
      postgres.db,
      [
        {
          eventId,
          cursor: "9",
          conversationRef,
          channelMessageId: "opaque-message-id",
          senderRef: "wxid-contact",
          kind: "file",
          content: fileName,
          mediaRef,
          fileName,
          mimeType: "application/pdf",
          occurredAt: "2026-08-23T00:00:00Z",
          observedAt: "2026-08-23T00:00:01Z",
          isSelf: false,
        },
      ],
      "9",
    );

    const messages = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, messageId));
    expect(messages).toHaveLength(1);
    // 文件名作为正文呈现，XML 永不进入 Core 公共字段
    expect(messages[0]).toMatchObject({
      contentType: "file",
      text: fileName,
    });

    const assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      sourceLocalId: null,
      sourceMediaRef: mediaRef,
      kind: "file",
      status: "queued",
    });

    const storage = new LocalFileStorage(root);
    const source: ChannelMediaSource = {
      resolveImage: () => {
        throw new Error("file assets must not use resolveImage");
      },
      resolveFile: (ref) => {
        expect(ref).toBe(mediaRef);
        const body = new Response(pdfBytes).body;
        if (!body) throw new Error("file response body is unavailable");
        return Promise.resolve({
          state: "ready",
          body,
          mimeType: "application/pdf",
        });
      },
      resolveAudio: () => {
        throw new Error("file assets must not use resolveAudio");
      },
    };

    await syncChannelMedia(postgres.db, storage, source);

    const synced = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    // 文件无视觉阶段：下载成功即 ready，可直接通过媒体端点查看
    expect(synced[0]).toMatchObject({ status: "ready" });
    const file = await postgres.db
      .select()
      .from(schema.storedFiles)
      .where(eq(schema.storedFiles.fileId, synced[0]?.originalFileId ?? ""));
    expect(file).toHaveLength(1);
    expect(file[0]?.mimeType).toBe("application/pdf");
    expect(file[0]?.originalName).toMatch(/\.pdf$/);
    await expect(
      readFile(join(root, file[0]?.storageKey ?? "")),
    ).resolves.toEqual(Buffer.from(pdfBytes));
  });
});

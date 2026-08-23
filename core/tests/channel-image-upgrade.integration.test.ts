import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
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
import { upgradeChannelImageOriginals } from "../modules/media/application/upgrade-channel-image-originals.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Channel image thumbnail upgrade", () => {
  let postgres: Postgres;
  let root: string;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationRef = `channel-thumb-${suffix}`;
  const conversationId = `channel:${conversationRef}`;
  const contactId = `contact:channel:${conversationRef}`;
  const thumbBytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
  const originalBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]);

  const makeSource = (
    mode: "thumbnail" | "original",
    seenRefs: string[],
  ): ChannelMediaSource => ({
    resolveImage: (ref) => {
      seenRefs.push(ref);
      const bytes = mode === "thumbnail" ? thumbBytes : originalBytes;
      const body = new Response(bytes).body;
      if (!body) throw new Error("response body is unavailable");
      return Promise.resolve({
        state: "ready",
        body,
        mimeType: "image/jpeg",
        variant: mode,
      });
    },
    resolveFile: () => {
      throw new Error("image assets must not use resolveFile");
    },
    resolveAudio: () => {
      throw new Error("image assets must not use resolveAudio");
    },
  });

  async function seedImage(eventSuffix: string): Promise<string> {
    const eventId = `channel:${conversationRef}:${eventSuffix}`;
    await ingestChannelEvents(
      postgres.db,
      [
        {
          eventId,
          cursor: eventSuffix,
          conversationRef,
          channelMessageId: `opaque-${eventSuffix}`,
          senderRef: "wxid-contact",
          kind: "image",
          content: "[image]",
          mediaRef: `${conversationRef}:media:${eventSuffix}`,
          occurredAt: "2026-08-23T00:00:00Z",
          observedAt: "2026-08-23T00:00:01Z",
          isSelf: false,
        },
      ],
      eventSuffix,
    );
    return eventId;
  }

  /** 模拟视觉阶段完成，使资产进入升级候选状态 */
  async function markReady(messageId: string, ageMs = 0): Promise<void> {
    const createdAt = new Date(Date.now() - ageMs);
    await postgres.db
      .update(schema.mediaAssets)
      .set({ status: "ready", processedAt: new Date(), createdAt })
      .where(eq(schema.mediaAssets.messageId, messageId));
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "weflow-channel-thumb-"));
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "channel-thumb-upgrade-test"),
    );
  });

  afterAll(async () => {
    const assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, conversationId));
    const fileIds = assets.flatMap((asset) =>
      [asset.originalFileId, asset.originalImageFileId].filter(
        (fileId): fileId is string => Boolean(fileId),
      ),
    );
    await postgres.db
      .delete(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, conversationId));
    for (const fileId of new Set(fileIds)) {
      await postgres.db
        .delete(schema.storedFiles)
        .where(eq(schema.storedFiles.fileId, fileId));
    }
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

  it("sync records thumbnail variant and upgrade fills the full-size original", async () => {
    const eventId = await seedImage("1");
    const messageId = `channel:${eventId}`;
    const storage = new LocalFileStorage(root);

    // 第一轮：Host 只有缩略图
    await syncChannelMedia(postgres.db, storage, makeSource("thumbnail", []));
    let assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    expect(assets[0]).toMatchObject({
      status: "processing_queued",
      sourceVariant: "thumbnail",
      originalImageFileId: null,
    });

    await markReady(messageId);

    // 密钥未就绪：仍返回缩略图 → 记一次退避重试，不填原图
    const pendingSeen: string[] = [];
    await upgradeChannelImageOriginals(
      postgres.db,
      storage,
      makeSource("thumbnail", pendingSeen),
    );
    assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    expect(assets[0]?.upgradeAttempt).toBe(1);
    expect(assets[0]?.sourceVariant).toBe("thumbnail");
    expect(assets[0]?.originalImageFileId).toBeNull();
    expect(assets[0]?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // 租约期内不重复抓取
    await upgradeChannelImageOriginals(
      postgres.db,
      storage,
      makeSource("thumbnail", []),
    );
    assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    expect(assets[0]?.upgradeAttempt).toBe(1);

    // 密钥就绪：重取原图并填充展示层之外的 originalImageFileId
    const readySeen: string[] = [];
    await postgres.db
      .update(schema.mediaAssets)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(schema.mediaAssets.messageId, messageId));
    await upgradeChannelImageOriginals(
      postgres.db,
      storage,
      makeSource("original", readySeen),
    );
    expect(readySeen).toEqual([`${conversationRef}:media:1`]);
    assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    expect(assets[0]).toMatchObject({
      sourceVariant: "original",
      errorCode: null,
    });
    const upgradedFileId = assets[0]?.originalImageFileId;
    expect(upgradedFileId).toBeTruthy();
    const files = await postgres.db
      .select()
      .from(schema.storedFiles)
      .where(eq(schema.storedFiles.fileId, upgradedFileId ?? ""));
    expect(files).toHaveLength(1);
    await expect(
      readFile(join(root, files[0]?.storageKey ?? "")),
    ).resolves.toEqual(Buffer.from(originalBytes));
    // 展示层文件仍是缩略图字节，未被替换
    const displayFiles = await postgres.db
      .select()
      .from(schema.storedFiles)
      .where(eq(schema.storedFiles.fileId, assets[0]?.originalFileId ?? ""));
    await expect(
      readFile(join(root, displayFiles[0]?.storageKey ?? "")),
    ).resolves.toEqual(Buffer.from(thumbBytes));
  });

  it("gives up after the retry window without touching the display tier", async () => {
    const eventId = await seedImage("2");
    const messageId = `channel:${eventId}`;
    const storage = new LocalFileStorage(root);

    await syncChannelMedia(postgres.db, storage, makeSource("thumbnail", []));
    // 直接置于超窗的 ready+thumbnail 状态
    const stale = new Date(Date.now() - 25 * 60 * 60_000);
    await postgres.db
      .update(schema.mediaAssets)
      .set({
        status: "ready",
        processedAt: new Date(),
        createdAt: stale,
        updatedAt: stale,
        nextAttemptAt: new Date(Date.now() - 1000),
      })
      .where(eq(schema.mediaAssets.messageId, messageId));

    await upgradeChannelImageOriginals(
      postgres.db,
      storage,
      makeSource("thumbnail", []),
    );

    const assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(and(eq(schema.mediaAssets.messageId, messageId)));
    expect(assets[0]).toMatchObject({
      status: "ready",
      errorCode: "source_original_unavailable",
    });
    expect(assets[0]?.nextAttemptAt.getFullYear()).toBe(9999);
    expect(assets[0]?.originalImageFileId).toBeNull();
  });
});

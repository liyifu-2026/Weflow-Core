/**
 * 媒体内容端点集成测试
 * 验证：failed 但文件存在 → 出图；queued（未就绪）→ 404 media_not_ready；
 * 文件记录存在但磁盘缺失 → 404 media_not_found；响应头 no-store。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStorage } from "../infrastructure/file_storage/local-file-storage.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { registerMediaRoutes } from "../modules/media/interface/http-routes.js";
import { registerIdentityRoutes } from "../modules/identity/interface/http-routes.js";
import { createClosedUser } from "../modules/identity/application/identity-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("media content endpoint", () => {
  let postgres: Postgres;
  let server: FastifyInstance;
  let root: string;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const userId = randomUUID();
  let cookie = "";
  const conversationId = `channel:media-content-${suffix}`;
  const contactId = `contact:channel:media-content-${suffix}`;
  const messageId = `media-content-message-${suffix}`;
  const mediaIds: string[] = [];
  const fileIds: string[] = [];

  async function seedMedia(
    status: string,
    writeDisk: boolean,
    mimeType = "image/jpeg",
    writeOriginal = false,
  ): Promise<string> {
    const storage = new LocalFileStorage(join(root, "media"));
    const mediaId = `media:${"a".repeat(63)}${String(mediaIds.length)}`;
    mediaIds.push(mediaId);
    let fileId: string | undefined;
    let originalFileId: string | undefined;
    if (writeDisk) {
      const written = await storage.write(
        Readable.from(Buffer.from(`fake-image-${mediaId}`)),
        `image-${suffix}.jpg`,
        mimeType,
      );
      fileId = written.fileId;
      fileIds.push(fileId);
      await postgres.db.insert(schema.storedFiles).values({
        fileId: written.fileId,
        ownerModule: "media",
        originalName: written.originalName,
        mimeType: written.mimeType,
        size: written.size,
        checksum: written.checksum,
        storageKey: written.storageKey,
        createdByUserId: userId,
      });
      if (writeOriginal) {
        const original = await storage.write(
          Readable.from(Buffer.from(`fake-original-${mediaId}`)),
          `original-${suffix}.jpg`,
          mimeType,
        );
        originalFileId = original.fileId;
        fileIds.push(original.fileId);
        await postgres.db.insert(schema.storedFiles).values({
          fileId: original.fileId,
          ownerModule: "media",
          originalName: original.originalName,
          mimeType: original.mimeType,
          size: original.size,
          checksum: original.checksum,
          storageKey: original.storageKey,
          createdByUserId: userId,
        });
      }
    }
    const rowMessageId = `${messageId}-${String(mediaIds.length)}`;
    await postgres.db.insert(schema.messages).values({
      messageId: rowMessageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "image",
      channelType: 1,
      text: "",
      processingState: "received",
      idempotencyKey: `media-content-${String(mediaIds.length)}-${suffix}`,
      occurredAt: new Date(),
      traceId: `media-content-${suffix}`,
    });
    await postgres.db.insert(schema.mediaAssets).values({
      mediaId,
      messageId: rowMessageId,
      conversationId,
      sourceConversationId: `source-${suffix}`,
      sourceLocalId: mediaIds.length,
      kind: "customer_image",
      status,
      originalFileId: fileId ?? null,
      originalImageFileId: originalFileId ?? null,
      errorCode: status === "failed" ? "vision_not_configured" : null,
    });
    return mediaId;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "weflow-media-content-"));
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "media-content-test"),
    );
    server = Fastify();
    registerIdentityRoutes(server, postgres.db);
    registerMediaRoutes(server, postgres.db, join(root, "media"));
    await server.ready();
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `media-content-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `media-content-${suffix}`,
    });
    const user = await createClosedUser(
      postgres.db,
      `media-${suffix}`,
      "Media-content-pass-1!",
    );
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: user.username, password: "Media-content-pass-1!" },
    });
    cookie =
      (login.headers["set-cookie"] as unknown as string).split(";")[0] ?? "";
    expect(cookie).toBeTruthy();
    const changed = await server.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: {
        currentPassword: "Media-content-pass-1!",
        newPassword: "Media-content-pass-2!",
      },
    });
    expect(changed.statusCode).toBe(200);
  });

  afterAll(async () => {
    for (const mediaId of mediaIds) {
      await postgres.db
        .delete(schema.mediaAssets)
        .where(eq(schema.mediaAssets.mediaId, mediaId));
    }
    for (const fileId of fileIds) {
      await postgres.db
        .delete(schema.storedFiles)
        .where(eq(schema.storedFiles.fileId, fileId));
    }
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
    await server.close();
    await postgres.close();
    await rm(root, { recursive: true, force: true });
  });

  it("streams the file for a failed asset whose file exists (人工仍可查看原图)", async () => {
    const mediaId = await seedMedia("failed", true);
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/media/${encodeURIComponent(mediaId)}/content`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toContain("fake-image");
  });

  it("streams the file for a ready asset", async () => {
    const mediaId = await seedMedia("ready", true);
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/media/${encodeURIComponent(mediaId)}/content`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("fake-image");
  });

  it("returns media_not_ready while the asset is still queued", async () => {
    const mediaId = await seedMedia("queued", false);
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/media/${encodeURIComponent(mediaId)}/content`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "media_not_ready" });
  });

  it("returns media_not_found when the file record exists but disk file is missing", async () => {
    // 记录存在但磁盘文件缺失：直接插入 storedFiles 记录而不写磁盘
    const storage = new LocalFileStorage(join(root, "media"));
    const written = await storage.write(
      Readable.from(Buffer.from("will-be-removed")),
      "gone.jpg",
      "image/jpeg",
    );
    fileIds.push(written.fileId);
    await postgres.db.insert(schema.storedFiles).values({
      fileId: written.fileId,
      ownerModule: "media",
      originalName: written.originalName,
      mimeType: written.mimeType,
      size: written.size,
      checksum: written.checksum,
      storageKey: written.storageKey,
      createdByUserId: userId,
    });
    await postgres.db.insert(schema.messages).values({
      messageId: `${messageId}-missing`,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "image",
      channelType: 1,
      text: "",
      processingState: "received",
      idempotencyKey: `media-content-missing-${suffix}`,
      occurredAt: new Date(),
      traceId: `media-content-missing-${suffix}`,
    });
    await postgres.db.insert(schema.mediaAssets).values({
      mediaId: `media:${"b".repeat(63)}1`,
      messageId: `${messageId}-missing`,
      conversationId,
      sourceConversationId: `source-missing-${suffix}`,
      sourceLocalId: 999,
      kind: "customer_image",
      status: "failed",
      originalFileId: written.fileId,
      errorCode: "vision_not_configured",
    });
    const missingMediaId = `media:${"b".repeat(63)}1`;
    mediaIds.push(missingMediaId);
    // 删除磁盘文件模拟文件丢失
    await new LocalFileStorage(join(root, "media")).remove(written.storageKey);
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/media/${encodeURIComponent(missingMediaId)}/content`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "media_not_found" });
  });

  it("streams the original image when it was downloaded", async () => {
    const mediaId = await seedMedia("ready", true, "image/jpeg", true);
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/media/${encodeURIComponent(mediaId)}/content/original`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toContain("fake-original");
  });

  it("returns media_original_not_found when no original was downloaded", async () => {
    const mediaId = await seedMedia("ready", true);
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/media/${encodeURIComponent(mediaId)}/content/original`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "media_original_not_found" });
  });

  it("reports original availability in metadata", async () => {
    const withOriginal = await seedMedia("ready", true, "image/jpeg", true);
    const meta = await server.inject({
      method: "GET",
      url: `/api/v1/media/${encodeURIComponent(withOriginal)}`,
      headers: { cookie },
    });
    expect(meta.statusCode).toBe(200);
    // seedMedia 的原图文件内容 = `fake-original-${mediaId}`，大小可精确断言
    const originalSize = Buffer.byteLength(`fake-original-${withOriginal}`);
    expect(meta.json()).toMatchObject({
      media: {
        original: { mimeType: "image/jpeg", size: originalSize },
      },
    });

    const withoutOriginal = await seedMedia("ready", true);
    const meta2 = await server.inject({
      method: "GET",
      url: `/api/v1/media/${encodeURIComponent(withoutOriginal)}`,
      headers: { cookie },
    });
    expect(meta2.statusCode).toBe(200);
    expect(meta2.json()).toMatchObject({ media: { original: null } });
  });
});

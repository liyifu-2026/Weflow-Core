/**
 * 媒体模块 HTTP 路由
 *
 * 提供媒体资产元数据查询、原始内容下载以及出站媒体上传（人工回复携带）。
 * 内容下载接口通过文件存储服务返回流式响应。
 */
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { LocalFileStorage } from "../../../infrastructure/file_storage/local-file-storage.js";
import {
  assertUploadAllowed,
  UploadTypeBlockedError,
} from "../../../infrastructure/file_storage/upload-policy.js";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";

const mediaParams = z.object({
  mediaId: z.string().regex(/^media:[a-f0-9]{64}$/),
});

/** 出站媒体 kind 由 MIME 推导（与入站媒体约定一致）。
 *  音频按 file 处理：出站语音转发已随协议 v5 裁剪，人工上传的音频以文件消息发送。 */
const MIME_KIND: Record<string, string> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/bmp": "image",
  "video/mp4": "video",
  "video/quicktime": "video",
  "audio/mpeg": "file",
  "audio/wav": "file",
  "audio/x-silk": "file",
  "audio/ogg": "file",
};

/** 注册媒体模块的所有 HTTP 路由 */
export function registerMediaRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  storageRoot: string,
): void {
  const storage = new LocalFileStorage(storageRoot);

  // 出站媒体上传：multipart 单文件 → storedFiles（临时持有）。
  // 返回 mediaId；mediaAssets 行由发送接口（manual reply 携带 mediaId）创建，
  // 此时才有真实的 messageId/conversationId（media_assets 外键约束）。
  server.post("/api/v1/media", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "invalid_request" });
    try {
      const mimeType = (file.mimetype || "").toLowerCase();
      const kind = MIME_KIND[mimeType] ?? "file";
      // 底线策略：拒绝可执行文件/脚本（黑名单，非白名单）
      assertUploadAllowed({
        originalName: file.filename || "upload.bin",
        mimeType,
      });
      const written = await storage.write(
        file.file,
        file.filename || "upload.bin",
        mimeType || "application/octet-stream",
      );
      const now = new Date();
      const mediaId = `media:${createHash("sha256")
        .update(written.fileId)
        .digest("hex")}`;
      await db.insert(schema.storedFiles).values({
        fileId: written.fileId,
        ownerModule: "manual-upload",
        originalName: written.originalName,
        mimeType: written.mimeType,
        size: written.size,
        checksum: written.checksum,
        storageKey: written.storageKey,
        createdByUserId: identity.user.userId,
        createdAt: now,
      });
      return reply.code(201).send({
        media: {
          mediaId,
          fileId: written.fileId,
          kind,
          mimeType: written.mimeType,
          size: written.size,
          originalName: written.originalName,
        },
      });
    } catch (error) {
      if (error instanceof UploadTypeBlockedError) {
        return reply.code(415).send({ error: "upload_type_blocked" });
      }
      return reply.code(500).send({
        error: "media_upload_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.get("/api/v1/media/:mediaId", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    const params = mediaParams.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const originalFiles = alias(schema.storedFiles, "stored_files_original");
    const derivedFiles = alias(schema.storedFiles, "stored_files_derived");
    const rows = await db
      .select({
        mediaId: schema.mediaAssets.mediaId,
        messageId: schema.mediaAssets.messageId,
        conversationId: schema.mediaAssets.conversationId,
        kind: schema.mediaAssets.kind,
        status: schema.mediaAssets.status,
        errorCode: schema.mediaAssets.errorCode,
        description: schema.mediaAssets.description,
        descriptionModel: schema.mediaAssets.descriptionModel,
        processedAt: schema.mediaAssets.processedAt,
        fileId: schema.storedFiles.fileId,
        mimeType: schema.storedFiles.mimeType,
        size: schema.storedFiles.size,
        checksum: schema.storedFiles.checksum,
        // 原图文件（高清查看）：未下载成功时为空，前端据此隐藏"查看原图"
        originalFileId: originalFiles.fileId,
        originalMimeType: originalFiles.mimeType,
        originalSize: originalFiles.size,
        // 语音派生播放文件（SILK→MP3）：存在时前端用它播放
        derivedFileId: derivedFiles.fileId,
        derivedMimeType: derivedFiles.mimeType,
        derivedSize: derivedFiles.size,
      })
      .from(schema.mediaAssets)
      .innerJoin(
        schema.conversations,
        eq(
          schema.conversations.conversationId,
          schema.mediaAssets.conversationId,
        ),
      )
      .leftJoin(
        schema.storedFiles,
        eq(schema.mediaAssets.originalFileId, schema.storedFiles.fileId),
      )
      .leftJoin(
        originalFiles,
        eq(schema.mediaAssets.originalImageFileId, originalFiles.fileId),
      )
      .leftJoin(
        derivedFiles,
        eq(schema.mediaAssets.derivedFileId, derivedFiles.fileId),
      )
      .where(eq(schema.mediaAssets.mediaId, params.data.mediaId))
      .limit(1);
    const media = rows[0];
    if (!media) return reply.code(404).send({ error: "media_not_found" });
    const {
      originalFileId,
      originalMimeType,
      originalSize,
      derivedFileId,
      derivedMimeType,
      derivedSize,
      ...rest
    } = media;
    return {
      media: {
        ...rest,
        original: originalFileId
          ? {
              fileId: originalFileId,
              mimeType: originalMimeType,
              size: originalSize,
            }
          : null,
        derived: derivedFileId
          ? {
              fileId: derivedFileId,
              mimeType: derivedMimeType,
              size: derivedSize,
            }
          : null,
      },
    };
  });

  server.get("/api/v1/media/:mediaId/content", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    const params = mediaParams.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const derivedFiles = alias(schema.storedFiles, "stored_files_derived");
    const rows = await db
      .select({
        status: schema.mediaAssets.status,
        mimeType: schema.storedFiles.mimeType,
        storageKey: schema.storedFiles.storageKey,
        size: schema.storedFiles.size,
        checksum: schema.storedFiles.checksum,
        // 原始文件名（出站=暂存原名；入站=Host 上报），Content-Disposition 用
        originalName: schema.storedFiles.originalName,
        // 语音派生播放文件（SILK→MP3）：存在时优先返回（浏览器/移动端可播）
        derivedMimeType: derivedFiles.mimeType,
        derivedStorageKey: derivedFiles.storageKey,
        derivedSize: derivedFiles.size,
        derivedChecksum: derivedFiles.checksum,
      })
      .from(schema.mediaAssets)
      .innerJoin(
        schema.conversations,
        eq(
          schema.conversations.conversationId,
          schema.mediaAssets.conversationId,
        ),
      )
      .innerJoin(
        schema.storedFiles,
        and(
          eq(schema.mediaAssets.originalFileId, schema.storedFiles.fileId),
          // 文件落盘即出图（ready=有视觉描述；failed=描述失败但原图可用）。
          // 图片不再等视觉描述：processing* 期间原文件已在盘上，早出图可省
          // 掉一次云端 vision 往返的首屏等待。语音仍保留门槛——转码派生 MP3
          // 前只能拿到不可播放的 SILK。
          or(
            inArray(schema.mediaAssets.status, ["ready", "failed"]),
            ne(schema.mediaAssets.kind, "voice"),
          ),
        ),
      )
      .leftJoin(
        derivedFiles,
        eq(schema.mediaAssets.derivedFileId, derivedFiles.fileId),
      )
      .where(eq(schema.mediaAssets.mediaId, params.data.mediaId))
      .limit(1);
    const media = rows[0];
    if (!media) return reply.code(404).send({ error: "media_not_ready" });
    // 语音已转码出 MP3：优先返回可播放的派生文件
    const playable =
      media.derivedStorageKey &&
      media.derivedChecksum &&
      (await storage.exists(media.derivedStorageKey))
        ? {
            mimeType: media.derivedMimeType,
            storageKey: media.derivedStorageKey,
            size: media.derivedSize,
            checksum: media.derivedChecksum,
          }
        : {
            mimeType: media.mimeType,
            storageKey: media.storageKey,
            size: media.size,
            checksum: media.checksum,
          };
    if (!(await storage.exists(playable.storageKey)))
      return reply.code(404).send({ error: "media_not_found" });
    // 内容按 mediaId 不可变（sha256 即 ETag）：允许客户端缓存并带校验重验，
    // 命中 304 时不再重传字节（此前 no-store 让每次重挂都全量下载）。
    const etag = `"${playable.checksum}"`;
    reply.header("etag", etag);
    reply.header("cache-control", "private, no-cache");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    reply.header("content-type", playable.mimeType);
    reply.header("content-length", String(playable.size));
    reply.header("x-content-type-options", "nosniff");
    // RFC 5987 filename*：非 ASCII 文件名（中文等）在浏览器下载/移动端
    // 分享时保留原名；filename= 为 ASCII 回退。
    const contentName = media.originalName ?? "attachment";
    reply.header(
      "content-disposition",
      `attachment; filename="${contentName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(contentName)}`,
    );
    return reply.send(storage.read(playable.storageKey));
  });

  server.get(
    "/api/v1/media/:mediaId/content/original",
    async (request, reply) => {
      if (!(await requireBusinessIdentity(db, request, reply))) return;
      const params = mediaParams.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const originalFiles = alias(schema.storedFiles, "stored_files_original");
      const rows = await db
        .select({
          status: schema.mediaAssets.status,
          mimeType: originalFiles.mimeType,
          storageKey: originalFiles.storageKey,
          size: originalFiles.size,
          checksum: originalFiles.checksum,
          originalName: originalFiles.originalName,
        })
        .from(schema.mediaAssets)
        .innerJoin(
          schema.conversations,
          eq(
            schema.conversations.conversationId,
            schema.mediaAssets.conversationId,
          ),
        )
        .innerJoin(
          originalFiles,
          // 原图未下载成功（originalImageFileId 为空）时，不返回原图
          eq(schema.mediaAssets.originalImageFileId, originalFiles.fileId),
        )
        .where(
          and(
            eq(schema.mediaAssets.mediaId, params.data.mediaId),
            // 与缩略图一致：文件落盘即出图（语音仍等派生 MP3）
            or(
              inArray(schema.mediaAssets.status, ["ready", "failed"]),
              ne(schema.mediaAssets.kind, "voice"),
            ),
          ),
        )
        .limit(1);
      const media = rows[0];
      if (!media)
        return reply.code(404).send({ error: "media_original_not_found" });
      if (!(await storage.exists(media.storageKey)))
        return reply.code(404).send({ error: "media_not_found" });
      const etag = `"${media.checksum}"`;
      reply.header("etag", etag);
      reply.header("cache-control", "private, no-cache");
      if (request.headers["if-none-match"] === etag)
        return reply.code(304).send();
      reply.header("content-type", media.mimeType);
      reply.header("content-length", String(media.size));
      reply.header("x-content-type-options", "nosniff");
      const originalName = media.originalName ?? "attachment";
      reply.header(
        "content-disposition",
        `attachment; filename="${originalName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(originalName)}`,
      );
      return reply.send(storage.read(media.storageKey));
    },
  );
}

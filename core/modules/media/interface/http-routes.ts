/**
 * 媒体模块 HTTP 路由
 *
 * 提供媒体资产元数据查询和原始内容下载的 REST API 端点。
 * 内容下载接口通过文件存储服务返回流式响应。
 */
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { LocalFileStorage } from "../../../infrastructure/file_storage/local-file-storage.js";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";

const mediaParams = z.object({
  mediaId: z.string().regex(/^media:[a-f0-9]{64}$/),
});

/** 注册媒体模块的所有 HTTP 路由 */
export function registerMediaRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  storageRoot: string,
): void {
  const storage = new LocalFileStorage(storageRoot);

  server.get("/api/v1/media/:mediaId", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    const params = mediaParams.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const originalFiles = alias(schema.storedFiles, "stored_files_original");
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
      .where(eq(schema.mediaAssets.mediaId, params.data.mediaId))
      .limit(1);
    const media = rows[0];
    if (!media) return reply.code(404).send({ error: "media_not_found" });
    const { originalFileId, originalMimeType, originalSize, ...rest } = media;
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
      },
    };
  });

  server.get("/api/v1/media/:mediaId/content", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    const params = mediaParams.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const rows = await db
      .select({
        status: schema.mediaAssets.status,
        mimeType: schema.storedFiles.mimeType,
        storageKey: schema.storedFiles.storageKey,
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
          // 文件已下载即出图（ready=有视觉描述；failed=描述失败但原图可用）。
          // 设计承诺"人工仍可查看图片文件"（media-processing-dispatcher），
          // queued/processing* 期间文件尚未落盘，仍返回 media_not_ready。
          inArray(schema.mediaAssets.status, ["ready", "failed"]),
        ),
      )
      .where(eq(schema.mediaAssets.mediaId, params.data.mediaId))
      .limit(1);
    const media = rows[0];
    if (!media) return reply.code(404).send({ error: "media_not_ready" });
    if (!(await storage.exists(media.storageKey)))
      return reply.code(404).send({ error: "media_not_found" });
    reply.header("content-type", media.mimeType);
    reply.header("cache-control", "private, no-store");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(storage.read(media.storageKey));
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
            // 与缩略图一致：文件已落盘即出图
            inArray(schema.mediaAssets.status, ["ready", "failed"]),
          ),
        )
        .limit(1);
      const media = rows[0];
      if (!media)
        return reply.code(404).send({ error: "media_original_not_found" });
      if (!(await storage.exists(media.storageKey)))
        return reply.code(404).send({ error: "media_not_found" });
      reply.header("content-type", media.mimeType);
      reply.header("cache-control", "private, no-store");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(storage.read(media.storageKey));
    },
  );
}

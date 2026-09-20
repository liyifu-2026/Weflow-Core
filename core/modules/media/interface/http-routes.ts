/**
 * 媒体模块 HTTP 路由
 *
 * 提供媒体资产元数据查询、原始内容下载以及出站媒体上传（人工回复携带）。
 * 内容下载接口通过文件存储服务返回流式响应。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { BusinessDb } from "../../identity/application/db.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";

import {
  getMediaMetadata,
  openMediaContent,
  openMediaOriginal,
  stageManualUpload,
  type MediaContent,
  type FileStorage,
} from "../application/media-access-service.js";

const mediaParams = z.object({
  mediaId: z.string().regex(/^media:[a-f0-9]{64}$/),
});

/** 注册媒体模块的所有 HTTP 路由 */
export function registerMediaRoutes(
  server: FastifyInstance,
  db: BusinessDb,
  storage: FileStorage,
): void {
  // 出站媒体上传：multipart 单文件 → storedFiles（临时持有）。
  // 返回 mediaId；mediaAssets 行由发送接口（manual reply 携带 mediaId）创建，
  // 此时才有真实的 messageId/conversationId（media_assets 外键约束）。
  server.post("/api/v1/media", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "invalid_request" });
    try {
      const result = await stageManualUpload(db, storage, {
        filename: file.filename || "upload.bin",
        mimeType: file.mimetype,
        stream: file.file,
        createdByUserId: identity.user.userId,
      });
      if (result.status === "upload_type_blocked") {
        return await reply.code(415).send({ error: "upload_type_blocked" });
      }
      return await reply.code(201).send({ media: result.media });
    } catch (error) {
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
    const media = await getMediaMetadata(db, params.data.mediaId);
    if (!media) return reply.code(404).send({ error: "media_not_found" });
    return { media };
  });

  server.get("/api/v1/media/:mediaId/content", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    const params = mediaParams.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const content = await openMediaContent(db, storage, params.data.mediaId);
    if (content.status === "not_ready")
      return reply.code(404).send({ error: "media_not_ready" });
    if (content.status === "not_found")
      return reply.code(404).send({ error: "media_not_found" });
    return sendMediaContent(reply, request.headers["if-none-match"], content);
  });

  server.get(
    "/api/v1/media/:mediaId/content/original",
    async (request, reply) => {
      if (!(await requireBusinessIdentity(db, request, reply))) return;
      const params = mediaParams.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const content = await openMediaOriginal(db, storage, params.data.mediaId);
      if (content.status === "not_ready")
        return reply.code(404).send({ error: "media_original_not_found" });
      if (content.status === "not_found")
        return reply.code(404).send({ error: "media_not_found" });
      return sendMediaContent(reply, request.headers["if-none-match"], content);
    },
  );
}

/** 内容响应：sha256 即 ETag（mediaId 内容不可变），命中 304 不重传字节 */
function sendMediaContent(
  reply: FastifyReply,
  ifNoneMatch: string | string[] | undefined,
  content: MediaContent,
) {
  const etag = `"${content.checksum}"`;
  reply.header("etag", etag);
  reply.header("cache-control", "private, no-cache");
  if (ifNoneMatch === etag) return reply.code(304).send();
  reply.header("content-type", content.mimeType ?? "application/octet-stream");
  reply.header("content-length", String(content.size ?? 0));
  reply.header("x-content-type-options", "nosniff");
  // RFC 5987 filename*：非 ASCII 文件名（中文等）在浏览器下载/移动端
  // 分享时保留原名；filename= 为 ASCII 回退。
  const contentName = content.originalName || "attachment";
  reply.header(
    "content-disposition",
    `attachment; filename="${contentName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(contentName)}`,
  );
  return reply.send(content.stream);
}

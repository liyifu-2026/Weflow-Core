/**
 * 素材空间 HTTP 路由
 *
 * 平台级、业务中立的素材库 API：本机上传入空间、图片/文件分类浏览（keyset
 * 分页 + 名称搜索）、重命名/软删除整理、内容流式下载。
 * 会话发送引用素材走 manual reply 的 assetId（conversations 模块）。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FileStorage } from "../../../infrastructure/file_storage/types.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import {
  ASSET_CATEGORY_VALUES,
  type AssetDb,
  type AssetProjection,
  type toAssetProjection,
} from "../application/asset-service.js";
import {
  deleteAsset,
  getAsset,
  getAssetContent,
  listAssets,
  recordAssetAudit,
  renameAsset,
  uploadAsset,
} from "../application/asset-service.js";

const listQuery = z.object({
  category: z.enum(ASSET_CATEGORY_VALUES).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(64).optional(),
});

const assetParams = z.object({
  assetId: z.uuid(),
});

const renameBody = z.object({
  name: z.string().trim().min(1).max(255),
});

/** 注册素材空间的所有 HTTP 路由 */
export function registerAssetRoutes(
  server: FastifyInstance,
  db: AssetDb,
  storage: FileStorage,
): void {
  // 本机上传入空间：multipart 单文件 → file_storage 持久持有 + assets.items 元数据
  server.post("/api/v1/assets", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "invalid_request" });
    try {
      const mimeType = (file.mimetype || "").toLowerCase();
      const result = await uploadAsset(db, storage, {
        stream: file.file,
        originalName: file.filename || "asset.bin",
        mimeType: mimeType || "application/octet-stream",
        actorUserId: identity.user.userId,
      });
      return await reply.code(201).send({ asset: result.projection });
    } catch (error) {
      return reply.code(500).send({
        error: "asset_upload_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 分页浏览（category 过滤 + 名称搜索 + keyset 游标；轻量不全量加载）
  server.get("/api/v1/assets", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    const query = listQuery.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    try {
      const page = await listAssets(db, {
        ...(query.data.category ? { category: query.data.category } : {}),
        ...(query.data.search ? { search: query.data.search } : {}),
        ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
        ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      });
      return { items: page.items, nextCursor: page.nextCursor };
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_asset_cursor") {
        return reply.code(400).send({ error: "invalid_cursor" });
      }
      throw error;
    }
  });

  server.get("/api/v1/assets/:assetId", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    const params = assetParams.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const result = await getAsset(db, params.data.assetId);
    if (result.status === "not_found")
      return reply.code(404).send({ error: "asset_not_found" });
    return { asset: result.projection };
  });

  // 内容流式下载（选择器缩略图/预览与发送前确认共用）
  server.get("/api/v1/assets/:assetId/content", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    const params = assetParams.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const content = await getAssetContent(db, params.data.assetId);
    if (!content) return reply.code(404).send({ error: "asset_not_found" });
    if (!(await storage.exists(content.storageKey)))
      return reply.code(404).send({ error: "asset_content_missing" });
    reply.header("content-type", content.mimeType);
    reply.header("cache-control", "private, max-age=3600");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(storage.read(content.storageKey));
  });

  // 重命名（整理）
  server.patch("/api/v1/assets/:assetId", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const params = assetParams.safeParse(request.params);
    const body = renameBody.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ error: "invalid_request" });
    try {
      const result = await renameAsset(db, params.data.assetId, body.data.name);
      if (result.status === "not_found")
        return await reply.code(404).send({ error: "asset_not_found" });
      await recordAssetAudit(db, {
        actorUserId: identity.user.userId,
        sourceIp: request.ip,
        eventType: "asset.renamed",
        assetId: params.data.assetId,
      });
      return { asset: result.projection };
    } catch (error) {
      if (error instanceof Error && error.message === "asset_name_required") {
        return reply.code(400).send({ error: "asset_name_required" });
      }
      throw error;
    }
  });

  // 软删除（整理）：列表不再可见；已发送消息不受影响
  server.delete("/api/v1/assets/:assetId", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const params = assetParams.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const result = await deleteAsset(db, params.data.assetId);
    if (result.status === "not_found")
      return reply.code(404).send({ error: "asset_not_found" });
    await recordAssetAudit(db, {
      actorUserId: identity.user.userId,
      sourceIp: request.ip,
      eventType: "asset.deleted",
      assetId: params.data.assetId,
    });
    return { asset: result.projection };
  });
}

/** 保留投影类型引用（导出给契约测试） */
export type { AssetProjection, toAssetProjection };

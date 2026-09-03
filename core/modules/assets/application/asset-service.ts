/**
 * 素材空间应用服务
 *
 * 平台级、业务中立的素材库：上传时持久持有文件（file_storage.files 持久引用），
 * 支持图片/文件两个分类维度；会话发送时可通过 assetId 引用已有素材，
 * 服务端确定性派生 mediaId，无需重新上传文件字节。
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FileStorage } from "../../../infrastructure/file_storage/types.js";
import * as schema from "../../../infrastructure/postgres/schema.js";

/** 出站媒体 kind 由 MIME 推导（与 media 模块 MIME_KIND 约定一致） */
export const ASSET_MIME_KIND: Record<string, "image" | "file"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/bmp": "image",
};

export const ASSET_CATEGORY_VALUES = ["image", "file"] as const;
export type AssetCategory = (typeof ASSET_CATEGORY_VALUES)[number];

/** 模块数据库类型（路由层经此引用，不直接触碰 Drizzle schema） */
export type AssetDb = NodePgDatabase<typeof schema>;

export type AssetItem = typeof schema.assetsItems.$inferSelect;

/** API 投影（不泄露 storageKey / fileId 等内部句柄） */
export type AssetProjection = {
  assetId: string;
  category: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: Date;
};

/** 素材行 → API 投影 */
export function toAssetProjection(asset: AssetItem): AssetProjection {
  return {
    assetId: asset.assetId,
    category: asset.category,
    name: asset.name,
    mimeType: asset.mimeType,
    size: asset.size,
    createdAt: asset.createdAt,
  };
}

/** 从 MIME 推导素材分类 */
export function assetCategoryFromMime(mimeType: string): AssetCategory {
  const normalized = (mimeType || "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (ASSET_MIME_KIND[normalized] === "image") return "image";
  return "file";
}

/** 上传素材输入 */
export type UploadAssetInput = {
  stream: NodeJS.ReadableStream;
  originalName: string;
  mimeType: string;
  actorUserId: string;
};

/** 上传素材：文件落盘（持久持有）+ 元数据入库 */
export async function uploadAsset(
  db: AssetDb,
  storage: FileStorage,
  input: UploadAssetInput,
): Promise<{ projection: AssetProjection }> {
  const mimeType =
    (input.mimeType || "").toLowerCase() || "application/octet-stream";
  const category = assetCategoryFromMime(mimeType);
  const written = await storage.write(
    input.stream,
    input.originalName || "asset.bin",
    mimeType,
  );
  const assetId = randomUUID();
  // 存储引擎只写文件字节；file_storage.files 元数据行由使用方模块登记
  // （与 media / identity 模块约定一致）。ownerModule='asset' 同时作为
  // 出站暂存目录解析依据（assets/ 子目录）。
  await db.insert(schema.storedFiles).values({
    fileId: written.fileId,
    ownerModule: "asset",
    originalName: written.originalName,
    mimeType: written.mimeType,
    size: written.size,
    checksum: written.checksum,
    storageKey: written.storageKey,
    createdByUserId: input.actorUserId,
    createdAt: new Date(),
  });
  const rows = await db
    .insert(schema.assetsItems)
    .values({
      assetId,
      fileId: written.fileId,
      category,
      name: sanitizeAssetName(input.originalName) || defaultAssetName(category),
      mimeType: written.mimeType,
      size: written.size,
      checksum: written.checksum,
      createdByUserId: input.actorUserId,
    })
    .returning();
  const asset = rows[0];
  if (!asset) throw new Error("asset_insert_failed");
  return { projection: toAssetProjection(asset) };
}

export type ListAssetsInput = {
  category?: AssetCategory;
  search?: string;
  limit?: number;
  cursor?: string;
};

/** 分页浏览结果（投影行，不含内部句柄） */
export type ListAssetsPage = {
  items: AssetProjection[];
  nextCursor: string | null;
};

/** 解析列表游标（createdAt 时间戳 + 32 位十六进制 assetId，倒序稳定分页） */
function decodeAssetCursor(
  cursor: string,
): { at: Date; assetId: string } | null {
  const match = /^(\d+)_([0-9a-f]{32})$/.exec(cursor);
  if (!match) return null;
  const at = new Date(Number(match[1]));
  const hex = match[2] ?? "";
  if (!hex || Number.isNaN(at.getTime())) return null;
  // 还原为库内带连字符的 UUID 形态，保证行比较语义一致
  const assetId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { at, assetId };
}

/** 编码列表游标 */
function encodeAssetCursor(item: { createdAt: Date; assetId: string }): string {
  return `${String(item.createdAt.getTime())}_${item.assetId.replace(/-/g, "")}`;
}

/** 分页浏览素材：keyset 分页（created_at DESC, asset_id DESC），快速轻量、不全量加载 */
export async function listAssets(
  db: AssetDb,
  input: ListAssetsInput,
): Promise<ListAssetsPage> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const cursor = input.cursor ? decodeAssetCursor(input.cursor) : null;
  if (input.cursor && !cursor) throw new Error("invalid_asset_cursor");
  const search = input.search?.trim();
  const conditions = [isNull(schema.assetsItems.deletedAt)];
  if (input.category) {
    conditions.push(eq(schema.assetsItems.category, input.category));
  }
  if (search) {
    conditions.push(
      ilike(schema.assetsItems.name, `%${escapeLikePattern(search)}%`),
    );
  }
  if (cursor) {
    conditions.push(
      sql`(${schema.assetsItems.createdAt}, ${schema.assetsItems.assetId}) < (${cursor.at.toISOString()}, ${cursor.assetId})`,
    );
  }
  const items = await db
    .select({
      assetId: schema.assetsItems.assetId,
      category: schema.assetsItems.category,
      name: schema.assetsItems.name,
      mimeType: schema.assetsItems.mimeType,
      size: schema.assetsItems.size,
      createdAt: schema.assetsItems.createdAt,
    })
    .from(schema.assetsItems)
    .where(and(...conditions))
    .orderBy(
      desc(schema.assetsItems.createdAt),
      desc(schema.assetsItems.assetId),
    )
    .limit(limit + 1);
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: hasMore && last ? encodeAssetCursor(last) : null,
  };
}

export type GetAssetResult =
  { status: "found"; projection: AssetProjection } | { status: "not_found" };

/** 读取单个素材（含已软删校验，发送路径使用） */
export async function getAsset(
  db: AssetDb,
  assetId: string,
): Promise<GetAssetResult> {
  const rows = await db
    .select()
    .from(schema.assetsItems)
    .where(
      and(
        eq(schema.assetsItems.assetId, assetId),
        isNull(schema.assetsItems.deletedAt),
      ),
    )
    .limit(1);
  const asset = rows[0];
  return asset
    ? { status: "found", projection: toAssetProjection(asset) }
    : { status: "not_found" };
}

export type MutateAssetResult =
  { status: "ok"; projection: AssetProjection } | { status: "not_found" };

/** 重命名素材（整理用） */
export async function renameAsset(
  db: AssetDb,
  assetId: string,
  name: string,
): Promise<MutateAssetResult> {
  const sanitized = sanitizeAssetName(name);
  if (!sanitized) throw new Error("asset_name_required");
  const rows = await db
    .update(schema.assetsItems)
    .set({ name: sanitized, updatedAt: new Date() })
    .where(
      and(
        eq(schema.assetsItems.assetId, assetId),
        isNull(schema.assetsItems.deletedAt),
      ),
    )
    .returning();
  const asset = rows[0];
  return asset
    ? { status: "ok", projection: toAssetProjection(asset) }
    : { status: "not_found" };
}

/** 软删除素材：列表不再可见；物理文件随 storedFiles 生命周期统一治理 */
export async function deleteAsset(
  db: AssetDb,
  assetId: string,
): Promise<MutateAssetResult> {
  const rows = await db
    .update(schema.assetsItems)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.assetsItems.assetId, assetId),
        isNull(schema.assetsItems.deletedAt),
      ),
    )
    .returning();
  const asset = rows[0];
  return asset
    ? { status: "ok", projection: toAssetProjection(asset) }
    : { status: "not_found" };
}

/**
 * 素材发送所需的确定性出站媒体标识。
 * mediaAssets 主键是 mediaId（同会话同素材重发必须不冲突），
 * 以「素材 + 会话 + clientRequestId」派生：幂等重试安全，重发天然产生新 mediaId。
 */
export function assetOutboundMediaId(
  assetId: string,
  clientRequestId: string,
): string {
  return `media:${createHash("sha256").update(`${assetId}\0${clientRequestId}`).digest("hex")}`;
}

/** 净化素材名：去路径、压空白、限长（与存储层 originalName 语义对齐） */
function sanitizeAssetName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  return base.replace(/\s+/g, " ").trim().slice(0, 255);
}

/** 素材内容读取信息（mimeType + 底层存储键；路由层不直接触碰 Drizzle） */
export type AssetContentInfo = { mimeType: string; storageKey: string };

/** 读取素材内容信息（含 storedFiles 存储键联查；不存在时 null） */
export async function getAssetContent(
  db: AssetDb,
  assetId: string,
): Promise<AssetContentInfo | null> {
  const rows = await db
    .select({
      mimeType: schema.assetsItems.mimeType,
      storageKey: schema.storedFiles.storageKey,
    })
    .from(schema.assetsItems)
    .innerJoin(
      schema.storedFiles,
      eq(schema.assetsItems.fileId, schema.storedFiles.fileId),
    )
    .where(
      and(
        eq(schema.assetsItems.assetId, assetId),
        isNull(schema.assetsItems.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** 记录素材整理类审计事件（重命名/删除） */
export async function recordAssetAudit(
  db: AssetDb,
  input: {
    actorUserId: string;
    sourceIp: string;
    eventType: string;
    assetId: string;
  },
): Promise<void> {
  await db.insert(schema.auditEvents).values({
    auditId: randomUUID(),
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    subjectType: "asset",
    subjectId: input.assetId,
    sourceIp: input.sourceIp,
    metadata: {},
  });
}

function defaultAssetName(category: AssetCategory): string {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return category === "image" ? `图片 ${stamp}` : `文件 ${stamp}`;
}

/** LIKE 模式转义（用户搜索词原样匹配） */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

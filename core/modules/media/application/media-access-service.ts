/**
 * Media 访问服务（application 层）：人工上传暂存、元数据联查、内容打开。
 *
 * 出站媒体上传只落 storedFiles（临时持有）；mediaAssets 行由发送接口
 * （manual reply 携带 mediaId）创建——那时才有真实的 messageId/conversationId
 * （media_assets 外键约束）。内容打开按「语音派生 MP3 优先」选择可播放文件，
 * 文件缺失返回 not_found 而非 500。
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import {
  assertUploadAllowed,
  UploadTypeBlockedError,
} from "../../../infrastructure/file_storage/upload-policy.js";
import type { FileStorage } from "../../../infrastructure/file_storage/types.js";

export type { FileStorage };

export type { UploadTypeBlockedError };

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

export type ManualUploadResult =
  | {
      status: "ok";
      media: {
        mediaId: string;
        fileId: string;
        kind: string;
        mimeType: string;
        size: number;
        originalName: string;
      };
    }
  | { status: "upload_type_blocked" };

/** 出站媒体上传：multipart 单文件 → storedFiles（临时持有），返回 mediaId */
export async function stageManualUpload(
  db: NodePgDatabase<typeof schema>,
  storage: FileStorage,
  input: {
    filename: string;
    mimeType: string;
    stream: NodeJS.ReadableStream;
    createdByUserId: string;
  },
): Promise<ManualUploadResult> {
  const mimeType = (input.mimeType || "").toLowerCase();
  const kind = MIME_KIND[mimeType] ?? "file";
  // 底线策略：拒绝可执行文件/脚本（黑名单，非白名单）
  try {
    assertUploadAllowed({
      originalName: input.filename || "upload.bin",
      mimeType,
    });
  } catch (error) {
    if (error instanceof UploadTypeBlockedError) {
      return { status: "upload_type_blocked" };
    }
    throw error;
  }
  const written = await storage.write(
    input.stream,
    input.filename || "upload.bin",
    mimeType || "application/octet-stream",
  );
  await db.insert(schema.storedFiles).values({
    fileId: written.fileId,
    ownerModule: "manual-upload",
    originalName: written.originalName,
    mimeType: written.mimeType,
    size: written.size,
    checksum: written.checksum,
    storageKey: written.storageKey,
    createdByUserId: input.createdByUserId,
    createdAt: new Date(),
  });
  return {
    status: "ok",
    media: {
      mediaId: `media:${createHash("sha256").update(written.fileId).digest("hex")}`,
      fileId: written.fileId,
      kind,
      mimeType: written.mimeType,
      size: written.size,
      originalName: written.originalName,
    },
  };
}

export type MediaMetadata = Awaited<ReturnType<typeof getMediaMetadata>>;

/** 媒体元数据联查（含原图与语音派生文件投影）；不存在时 undefined */
export async function getMediaMetadata(
  db: NodePgDatabase<typeof schema>,
  mediaId: string,
) {
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
    .where(eq(schema.mediaAssets.mediaId, mediaId))
    .limit(1);
  const media = rows[0];
  if (!media) return undefined;
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
    ...rest,
    original: originalFileId
      ? {
          fileId: originalFileId,
          mimeType: originalMimeType,
          size: originalSize,
        }
      : null,
    derived: derivedFileId
      ? { fileId: derivedFileId, mimeType: derivedMimeType, size: derivedSize }
      : null,
  };
}

export type MediaContentStatus = "not_ready" | "not_found" | "ok";

export type MediaContent = {
  status: "ok";
  mimeType: string | null;
  size: number | null;
  checksum: string;
  originalName: string;
  stream: NodeJS.ReadableStream;
};

/** 打开可播放内容（语音已转码时优先派生 MP3）；文件缺失 → not_found */
export async function openMediaContent(
  db: NodePgDatabase<typeof schema>,
  storage: FileStorage,
  mediaId: string,
): Promise<MediaContent | { status: "not_ready" } | { status: "not_found" }> {
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
    .where(eq(schema.mediaAssets.mediaId, mediaId))
    .limit(1);
  const media = rows[0];
  if (!media) return { status: "not_ready" };
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
  if (!(await storage.exists(playable.storageKey))) {
    return { status: "not_found" };
  }
  return {
    status: "ok",
    mimeType: playable.mimeType,
    size: playable.size,
    checksum: playable.checksum,
    originalName: media.originalName,
    stream: storage.read(playable.storageKey),
  };
}

/** 打开原图（originalImageFileId 为空 = 原图未下载成功，不返回） */
export async function openMediaOriginal(
  db: NodePgDatabase<typeof schema>,
  storage: FileStorage,
  mediaId: string,
): Promise<MediaContent | { status: "not_ready" } | { status: "not_found" }> {
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
        eq(schema.mediaAssets.mediaId, mediaId),
        // 与缩略图一致：文件落盘即出图（语音仍等派生 MP3）
        or(
          inArray(schema.mediaAssets.status, ["ready", "failed"]),
          ne(schema.mediaAssets.kind, "voice"),
        ),
      ),
    )
    .limit(1);
  const media = rows[0];
  if (!media) return { status: "not_ready" };
  if (!(await storage.exists(media.storageKey))) return { status: "not_found" };
  return {
    status: "ok",
    mimeType: media.mimeType,
    size: media.size,
    checksum: media.checksum,
    originalName: media.originalName,
    stream: storage.read(media.storageKey),
  };
}

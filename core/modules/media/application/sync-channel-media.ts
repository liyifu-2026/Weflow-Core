/**
 * 入站 Channel Host 媒体同步（图片、文件附件与语音）。
 *
 * Channel Host 只返回 opaque mediaRef 对应的媒体流；长期文件事实仍由
 * Weflow File Storage/mediaAssets 持有。该路径不读取或解析通道私有 ID。
 *
 * 图片与语音进入处理阶段（processing_queued：视觉描述 / 语音转写）；
 * 文件附件没有派生阶段，下载成功即 ready，人工可直接通过媒体端点查看。
 */
import { Readable } from "node:stream";
import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalFileStorage } from "../../../infrastructure/file_storage/local-file-storage.js";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { ChannelMediaSource } from "../../channel/contracts/channel-media-source.js";

const SYSTEM_ACTOR = "system-channel-host";

/** 参与同步的资产类型：图片（视觉描述）、文件附件（无派生阶段）、语音（转写） */
const SYNC_KINDS = ["image", "file", "voice"] as const;

export async function syncChannelMedia(
  db: NodePgDatabase<typeof schema>,
  storage: LocalFileStorage,
  source: ChannelMediaSource,
): Promise<void> {
  const assets = await db
    .select()
    .from(schema.mediaAssets)
    .where(
      and(
        inArray(schema.mediaAssets.kind, [...SYNC_KINDS]),
        inArray(schema.mediaAssets.status, ["queued", "downloading"]),
        isNotNull(schema.mediaAssets.sourceMediaRef),
        lte(schema.mediaAssets.nextAttemptAt, new Date()),
      ),
    )
    .orderBy(asc(schema.mediaAssets.createdAt))
    .limit(10);

  for (const asset of assets) {
    const claimed = await db
      .update(schema.mediaAssets)
      .set({
        status: "downloading",
        attempt: asset.attempt + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.mediaAssets.mediaId, asset.mediaId),
          inArray(schema.mediaAssets.status, ["queued", "downloading"]),
        ),
      )
      .returning({ mediaId: schema.mediaAssets.mediaId });
    if (claimed.length === 0 || !asset.sourceMediaRef) continue;

    try {
      const result =
        asset.kind === "file"
          ? await source.resolveFile(asset.sourceMediaRef)
          : asset.kind === "voice"
            ? await source.resolveAudio(asset.sourceMediaRef)
            : await source.resolveImage(asset.sourceMediaRef);
      if (result.state === "pending") {
        await scheduleRetry(db, asset.mediaId, asset.attempt, "source_pending");
        continue;
      }
      if (result.state === "not_found") {
        await db
          .update(schema.mediaAssets)
          .set({
            status: "failed",
            errorCode: "source_not_found",
            updatedAt: new Date(),
          })
          .where(eq(schema.mediaAssets.mediaId, asset.mediaId));
        continue;
      }
      if (result.state === "failed") {
        await db
          .update(schema.mediaAssets)
          .set({
            status: "failed",
            errorCode: result.errorCode,
            updatedAt: new Date(),
          })
          .where(eq(schema.mediaAssets.mediaId, asset.mediaId));
        continue;
      }

      const file = await storage.write(
        Readable.fromWeb(result.body),
        `${asset.mediaId}${extensionForMime(asset.kind, result.mimeType)}`,
        result.mimeType,
      );
      try {
        await db.transaction(async (transaction) => {
          await transaction.insert(schema.storedFiles).values({
            ...file,
            ownerModule: "media",
            createdByUserId: SYSTEM_ACTOR,
          });
          await transaction
            .update(schema.mediaAssets)
            .set({
              // 文件附件无派生阶段：落盘即可供人工查看。
              // 图片/语音仍需描述/转写，交给 media-processing-dispatcher。
              status: asset.kind === "file" ? "ready" : "processing_queued",
              originalFileId: file.fileId,
              // thumbnail=Host 缩略图回退（可升级原图）；缺省 original
              sourceVariant:
                result.variant === "thumbnail" ? "thumbnail" : "original",
              errorCode: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.mediaAssets.mediaId, asset.mediaId));
        });
      } catch (error) {
        await storage.remove(file.storageKey);
        throw error;
      }
    } catch {
      await db
        .update(schema.mediaAssets)
        .set({
          status: asset.attempt >= 2 ? "failed" : "queued",
          errorCode: "source_error",
          nextAttemptAt: new Date(Date.now() + 5_000),
          updatedAt: new Date(),
        })
        .where(eq(schema.mediaAssets.mediaId, asset.mediaId));
    }
  }
}

async function scheduleRetry(
  db: NodePgDatabase<typeof schema>,
  mediaId: string,
  attempt: number,
  errorCode: string,
): Promise<void> {
  await db
    .update(schema.mediaAssets)
    .set({
      status: attempt >= 2 ? "failed" : "queued",
      errorCode: attempt >= 2 ? errorCode : errorCode,
      nextAttemptAt: new Date(
        Date.now() + Math.min(60_000, 2 ** attempt * 1_000),
      ),
      updatedAt: new Date(),
    })
    .where(eq(schema.mediaAssets.mediaId, mediaId));
}

const FILE_MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/json": ".json",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
  "application/octet-stream": ".bin",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "audio/mpeg": ".mp3",
  "audio/x-silk": ".silk",
  "video/mp4": ".mp4",
};

function extensionForMime(kind: string, mimeType: string): string {
  if (kind === "image") {
    if (mimeType === "image/png") return ".png";
    if (mimeType === "image/gif") return ".gif";
    return ".jpg";
  }
  if (kind === "voice") {
    if (mimeType === "audio/x-silk") return ".silk";
    if (mimeType === "audio/mpeg") return ".mp3";
    return ".audio";
  }
  return FILE_MIME_EXTENSIONS[mimeType] ?? ".bin";
}

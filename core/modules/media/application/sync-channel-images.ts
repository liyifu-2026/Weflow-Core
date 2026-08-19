/**
 * 入站 Channel Host 图片同步。
 *
 * Channel Host 只返回 opaque mediaRef 对应的图片流；长期文件事实仍由
 * Weflow File Storage/mediaAssets 持有。该路径不读取或解析通道私有 ID。
 */
import { Readable } from "node:stream";
import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalFileStorage } from "../../../infrastructure/file_storage/local-file-storage.js";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { ChannelMediaSource } from "../../channel/contracts/channel-media-source.js";

const SYSTEM_ACTOR = "system-channel-host";

export async function syncChannelImages(
  db: NodePgDatabase<typeof schema>,
  storage: LocalFileStorage,
  source: ChannelMediaSource,
): Promise<void> {
  const assets = await db
    .select()
    .from(schema.mediaAssets)
    .where(
      and(
        inArray(schema.mediaAssets.kind, ["image"]),
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
      const result = await source.resolveImage(asset.sourceMediaRef);
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
        `${asset.mediaId}${extensionForMime(result.mimeType)}`,
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
              status: "processing_queued",
              originalFileId: file.fileId,
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

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/gif") return ".gif";
  return ".jpg";
}

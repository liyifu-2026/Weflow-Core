/**
 * 缩略图原图升级。
 *
 * 无 AES 密钥时 Channel Host 以缩略图回退（X-Media-Variant: thumbnail），
 * 展示不受影响但清晰度受限。本任务在密钥就绪后重取全尺寸原图并填充
 * originalImageFileId（"查看原图"入口自动点亮）。不重跑视觉描述——若视觉
 * 尚未完成，processImageDescription 会自动优先使用新原图；已完成则保留
 * 既有描述，避免双倍视觉成本。
 */
import { Readable } from "node:stream";
import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalFileStorage } from "../../../infrastructure/file_storage/local-file-storage.js";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { ChannelMediaSource } from "../../channel/contracts/channel-media-source.js";

const SYSTEM_ACTOR = "system-channel-host";

/** 每轮升级处理的资产上限 */
const UPGRADE_BATCH = 10;
/** 升级重试退避：10 分钟起步，封顶 60 分钟 */
const RETRY_MIN_MS = 10 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** 距创建超过该窗口仍拿不到原图则放弃（缩略图展示不受影响） */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
/** 放弃后的 nextAttemptAt 哨兵值：不再进入候选集 */
const GIVE_UP_NEXT_ATTEMPT = new Date("9999-01-01T00:00:00.000Z");

export async function upgradeChannelImageOriginals(
  db: NodePgDatabase<typeof schema>,
  storage: LocalFileStorage,
  source: ChannelMediaSource,
): Promise<void> {
  const now = new Date();
  const candidates = await db
    .select()
    .from(schema.mediaAssets)
    .where(
      and(
        eq(schema.mediaAssets.kind, "image"),
        eq(schema.mediaAssets.status, "ready"),
        eq(schema.mediaAssets.sourceVariant, "thumbnail"),
        isNotNull(schema.mediaAssets.sourceMediaRef),
        isNull(schema.mediaAssets.originalImageFileId),
        lte(schema.mediaAssets.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(schema.mediaAssets.nextAttemptAt))
    .limit(UPGRADE_BATCH);

  for (const asset of candidates) {
    // 租约式抢占：以 upgradeAttempt 等值做乐观锁（timestamp 等值受微秒
    // 精度影响不可靠）；status 保持 ready，展示层全程可用。
    const leased = await db
      .update(schema.mediaAssets)
      .set({
        nextAttemptAt: new Date(Date.now() + RETRY_MIN_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.mediaAssets.mediaId, asset.mediaId),
          eq(schema.mediaAssets.upgradeAttempt, asset.upgradeAttempt),
        ),
      )
      .returning({ mediaId: schema.mediaAssets.mediaId });
    if (leased.length === 0 || !asset.sourceMediaRef) continue;

    try {
      const result = await source.resolveImage(asset.sourceMediaRef);
      if (
        result.state === "ready" &&
        (result.variant ?? "original") === "original"
      ) {
        const file = await storage.write(
          Readable.fromWeb(result.body),
          `${asset.mediaId}-original${extensionForMime(result.mimeType)}`,
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
                originalImageFileId: file.fileId,
                sourceVariant: "original",
                errorCode: null,
                upgradeAttempt: asset.upgradeAttempt + 1,
                updatedAt: new Date(),
              })
              .where(eq(schema.mediaAssets.mediaId, asset.mediaId));
          });
        } catch (error) {
          await storage.remove(file.storageKey);
          throw error;
        }
        continue;
      }
      await scheduleUpgradeRetry(db, asset);
    } catch {
      await scheduleUpgradeRetry(db, asset);
    }
  }
}

async function scheduleUpgradeRetry(
  db: NodePgDatabase<typeof schema>,
  asset: typeof schema.mediaAssets.$inferSelect,
): Promise<void> {
  const attempt = asset.upgradeAttempt + 1;
  const createdMs = asset.createdAt.getTime();
  const gaveUp = Date.now() - createdMs >= GIVE_UP_AFTER_MS;
  const backoffMs = Math.min(
    RETRY_MAX_MS,
    RETRY_MIN_MS * 2 ** Math.max(0, attempt - 1),
  );
  await db
    .update(schema.mediaAssets)
    .set({
      upgradeAttempt: attempt,
      // 放弃时统一标记终态原因；重试期间不覆盖既有错误信息
      errorCode: gaveUp ? "source_original_unavailable" : asset.errorCode,
      nextAttemptAt: gaveUp
        ? GIVE_UP_NEXT_ATTEMPT
        : new Date(Date.now() + backoffMs),
      updatedAt: new Date(),
    })
    .where(eq(schema.mediaAssets.mediaId, asset.mediaId));
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/gif") return ".gif";
  return ".jpg";
}

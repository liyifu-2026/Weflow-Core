/**
 * 图片描述处理
 *
 * 调用视觉模型对媒体资产中的图片进行描述生成。
 * 处理完成后更新媒体状态为 ready，并触发关联的 Agent Turn。
 * 处理失败时会将状态回退到 processing_queued 以便重试。
 */
import { and, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalFileStorage } from "../../../infrastructure/file_storage/local-file-storage.js";
import type { MimoVisionClient } from "../../../infrastructure/model_runtime/mimo-vision-client.js";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { resolveExecutionProfileForAdmission } from "../../agent/application/execution-profile-service.js";

/** 视觉描述用原图字节上限：超过则回退缩略图（防模型超时与账单暴涨） */
const MAX_DESCRIPTION_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * 处理单张图片的描述生成
 *
 * 通过乐观锁（CAS）抢占任务，读取图片文件内容后调用视觉模型生成描述。
 * 成功后在事务中同时更新媒体状态并创建新的 Agent Turn。
 */
export async function processImageDescription(
  db: NodePgDatabase<typeof schema>,
  storage: LocalFileStorage,
  client: MimoVisionClient,
  model: "mimo-v2.5",
  mediaId: string,
): Promise<void> {
  const originalFiles = alias(schema.storedFiles, "stored_files_original");
  const rows = await db
    .select({
      media: schema.mediaAssets,
      file: schema.storedFiles,
      originalFile: originalFiles,
    })
    .from(schema.mediaAssets)
    .innerJoin(
      schema.storedFiles,
      eq(schema.mediaAssets.originalFileId, schema.storedFiles.fileId),
    )
    .leftJoin(
      originalFiles,
      eq(schema.mediaAssets.originalImageFileId, originalFiles.fileId),
    )
    .where(eq(schema.mediaAssets.mediaId, mediaId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`media ${mediaId} does not have a source file`);
  if (row.media.status === "ready") return;

  const claimed = await db
    .update(schema.mediaAssets)
    .set({
      status: "processing",
      attempt: row.media.attempt + 1,
      errorCode: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.mediaAssets.mediaId, mediaId),
        ne(schema.mediaAssets.status, "ready"),
      ),
    )
    .returning({ mediaId: schema.mediaAssets.mediaId });
  if (claimed.length === 0) return;

  try {
    // 视觉描述优先用原图（清晰度更好）；原图缺失或过大时回退缩略图
    const originalFile = row.originalFile;
    const hasUsableOriginal =
      originalFile !== null && originalFile.size <= MAX_DESCRIPTION_IMAGE_BYTES;
    const sourceFile = hasUsableOriginal ? originalFile : row.file;
    const chunks: Buffer[] = [];
    for await (const chunk of storage.read(sourceFile.storageKey)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const description = await client.describe(
      Buffer.concat(chunks),
      sourceFile.mimeType,
      model,
    );
    await db.transaction(async (transaction) => {
      await transaction
        .update(schema.mediaAssets)
        .set({
          status: "ready",
          description,
          descriptionModel: model,
          processedAt: new Date(),
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.mediaAssets.mediaId, mediaId));
      const admission = await resolveExecutionProfileForAdmission(transaction);
      if (admission.allowed) {
        await transaction
          .insert(schema.agentTurns)
          .values({
            turnId: `turn:${row.media.messageId}`,
            triggerMessageId: row.media.messageId,
            conversationId: row.media.conversationId,
            status: "queued",
            executionProfileId: admission.profile.profileId,
            traceId: `media:${mediaId}`,
          })
          .onConflictDoNothing();
      }
    });
  } catch (error) {
    await db
      .update(schema.mediaAssets)
      .set({
        status: "processing_queued",
        errorCode: "vision_request_failed",
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    throw error;
  }
}

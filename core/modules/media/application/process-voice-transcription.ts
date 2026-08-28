/**
 * 语音转写处理（备选 ASR 路径）
 *
 * 针对无通道侧转写文本的语音资产：读取已落盘的 SILK 原始文件 →
 * 平台转码器产出 MP3 → MimoAudioClient 转写中文文本。
 * 成功后在事务中同时更新媒体状态 ready 并创建 Agent Turn；
 * ASR 失败回退 processing_queued 交由队列有界重试（耗尽后 retry_exhausted
 * → 降级 Turn）；转码工具缺失为终态失败（transcode_unavailable），
 * 立即停止重试，由 dispatcher 的降级 Turn 扫描兜底，消息不静默。
 */
import { and, eq, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalFileStorage } from "../../../infrastructure/file_storage/local-file-storage.js";
import type { SilkToMp3Transcoder } from "../../../infrastructure/media/audio-transcoder.js";
import type { MimoAudioClient } from "../../../infrastructure/model_runtime/mimo-audio-client.js";
import type { AudioTranscriptionsClient } from "../../../infrastructure/model_runtime/audio-transcriptions-client.js";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { resolveExecutionProfileForAdmission } from "../../agent/application/execution-profile-service.js";

/** ASR 客户端统一接缝（MiMo 内联音频 / 标准 audio/transcriptions 均可） */
export type VoiceTranscriptionClient = Pick<
  MimoAudioClient | AudioTranscriptionsClient,
  "transcribe"
>;

export type VoiceTranscriptionDependencies = {
  /** SILK→MP3 转码器；未注入视为平台转码能力缺失（诚实降级，不重试） */
  transcoder: SilkToMp3Transcoder | undefined;
};

/** 已可直接交给 ASR 的音频 MIME（无需转码） */
const ASR_READY_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/flac",
  "audio/mp4",
  "audio/m4a",
]);

export async function processVoiceTranscription(
  db: NodePgDatabase<typeof schema>,
  storage: LocalFileStorage,
  client: VoiceTranscriptionClient,
  model: string,
  mediaId: string,
  dependencies: VoiceTranscriptionDependencies,
): Promise<void> {
  const rows = await db
    .select({
      media: schema.mediaAssets,
      file: schema.storedFiles,
    })
    .from(schema.mediaAssets)
    .innerJoin(
      schema.storedFiles,
      eq(schema.mediaAssets.originalFileId, schema.storedFiles.fileId),
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

  // 可重试失败写入的 errorCode；终态失败路径直接 return，不经此外层落库
  let retryableErrorCode = "asr_request_failed";
  try {
    if (
      !dependencies.transcoder &&
      !ASR_READY_MIME_TYPES.has(row.file.mimeType)
    ) {
      // 转码工具链未配置：终态失败。重试无意义，交由降级 Turn 兜底。
      await db
        .update(schema.mediaAssets)
        .set({
          status: "failed",
          errorCode: "transcode_unavailable",
          updatedAt: new Date(),
        })
        .where(eq(schema.mediaAssets.mediaId, mediaId));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of storage.read(row.file.storageKey)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const source: Buffer = Buffer.concat(chunks);
    let transcriptionInput: Buffer = source;
    let transcriptionMime = row.file.mimeType;
    if (!ASR_READY_MIME_TYPES.has(row.file.mimeType)) {
      const transcoder = dependencies.transcoder;
      if (!transcoder) {
        await db
          .update(schema.mediaAssets)
          .set({
            status: "failed",
            errorCode: "transcode_unavailable",
            updatedAt: new Date(),
          })
          .where(eq(schema.mediaAssets.mediaId, mediaId));
        return;
      }
      try {
        transcriptionInput = await transcoder.transcodeToMp3(source);
        transcriptionMime = "audio/mpeg";
      } catch (error) {
        if ((error as { code?: string }).code === "transcode_unavailable") {
          // 运行中发现转码工具缺失：同样终态失败，不重试
          await db
            .update(schema.mediaAssets)
            .set({
              status: "failed",
              errorCode: "transcode_unavailable",
              updatedAt: new Date(),
            })
            .where(eq(schema.mediaAssets.mediaId, mediaId));
          return;
        }
        // 其余转码失败按可重试处理（有界）；错误码在外层统一落库
        retryableErrorCode = "transcode_failed";
        throw error;
      }
    }
    const description = await client.transcribe(
      transcriptionInput,
      transcriptionMime,
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
    // 转写/转码失败：回退排队等待有界重试；错误向上抛给 BullMQ 记录
    await db
      .update(schema.mediaAssets)
      .set({
        status: "processing_queued",
        errorCode: retryableErrorCode,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.mediaAssets.mediaId, mediaId),
          ne(schema.mediaAssets.status, "ready"),
        ),
      )
      .catch(() => undefined);
    throw error;
  }
}

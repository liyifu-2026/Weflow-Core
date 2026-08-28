/**
 * 媒体摄入 Worker 进程入口
 *
 * 职责：
 * - 从 Redis 队列消费媒体处理任务
 * - 图片：使用视觉模型（MimoVision）生成文字描述
 * - 语音：SILK→MP3 转码 + MiMo ASR 中文转写
 * - 将结果持久化到数据库，供后续对话上下文使用
 */
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { LocalFileStorage } from "../../infrastructure/file_storage/local-file-storage.js";
import { PysilkFfmpegTranscoder } from "../../infrastructure/media/audio-transcoder.js";
import { MEDIA_PROCESSING_QUEUE } from "../../infrastructure/redis/media-processing-dispatcher.js";
import {
  bullMqConnection,
  type JobEnvelope,
} from "../../infrastructure/redis/job-queue.js";
import { runProcess } from "../../infrastructure/runtime/run-process.js";
import * as schema from "../../infrastructure/postgres/schema.js";
import { MimoVisionClient } from "../../infrastructure/model_runtime/mimo-vision-client.js";
import { MimoAudioClient } from "../../infrastructure/model_runtime/mimo-audio-client.js";
import { processImageDescription } from "../../modules/media/application/process-image-description.js";
import { processVoiceTranscription } from "../../modules/media/application/process-voice-transcription.js";
import { readRuntimeSettings } from "../../modules/operations/application/runtime-settings.js";
import { AudioTranscriptionsClient } from "../../infrastructure/model_runtime/audio-transcriptions-client.js";

await runProcess({
  name: "ingestion-worker",
  healthPort: (config) => config.ingestionWorkerHealthPort,
  start: ({ config, logger, postgres }) => {
    // 初始化本地文件存储，用于读取媒体文件
    const mediaStorage = new LocalFileStorage(
      `${config.fileStorageRoot}/media`,
    );
    const vision = config.vision;
    // 专用 ASR 端点（OpenAI 兼容 audio/transcriptions，如硅基流动）
    const asr = config.asr;
    // 仅在配置了多模态模型时创建媒体处理队列消费者（图片视觉 / 语音 ASR 共用端点）
    const mediaWorker = vision
      ? new Worker<JobEnvelope>(
          MEDIA_PROCESSING_QUEUE,
          async (job) => {
            // 运行时模型选择：切换 vision_model 无需重启
            const runtime = await readRuntimeSettings(postgres.db);
            if (job.data.jobType === "media.transcribe_voice") {
              // 语音转写：读取 SILK → 平台转码器产出 MP3 → ASR → 持久化描述。
              // 转码工具链路径：VOICE_PYTHON_PATH / VOICE_FFMPEG_PATH 优先，
              // 回退到本机部署约定（channel-host venv 的 pysilk + 工具箱 ffmpeg）。
              const pythonPath =
                process.env.VOICE_PYTHON_PATH ??
                "C:\\Users\\12991\\Desktop\\We\\weflow\\runtimes\\channel-host-wechat\\.venv\\Scripts\\python.exe";
              const ffmpegPath =
                process.env.VOICE_FFMPEG_PATH ??
                "C:\\Program Files (x86)\\MarukoToolbox\\tools\\ffmpeg.exe";
              // 配置了专用 ASR 端点时用标准 audio/transcriptions 客户端，
              // 否则回落 MiMo chat/completions 内联音频。
              const audioClient = asr
                ? new AudioTranscriptionsClient({
                    baseUrl: asr.baseUrl,
                    apiKey: asr.apiKey,
                    model: asr.model,
                    timeoutMs: asr.timeoutMs,
                  })
                : new MimoAudioClient({
                    baseUrl: vision.baseUrl,
                    apiKey: vision.apiKey,
                    model: vision.asrModel,
                    timeoutMs: vision.timeoutMs,
                  });
              await processVoiceTranscription(
                postgres.db,
                mediaStorage,
                audioClient,
                asr?.model ?? vision.asrModel,
                job.data.businessEntityId,
                {
                  transcoder: new PysilkFfmpegTranscoder({
                    pythonPath,
                    ffmpegPath,
                    onDiagnostics: (line) => {
                      logger.debug({ line }, "audio transcode diagnostics");
                    },
                  }),
                },
              );
              return;
            }
            // 图片描述：读取图片 -> 调用视觉模型 -> 持久化描述
            await processImageDescription(
              postgres.db,
              mediaStorage,
              new MimoVisionClient({
                baseUrl: vision.baseUrl,
                apiKey: vision.apiKey,
                model: vision.name,
                timeoutMs: vision.timeoutMs,
              }),
              runtime.visionModel,
              job.data.businessEntityId,
            );
          },
          {
            connection: bullMqConnection(config.redisUrl),
            // 并发由 MEDIA_PROCESSING_CONCURRENCY 控制：默认 1 避免多模态模型过载，
            // 50 并发会话场景下大量图片/语音同时到达时可按模型承载上调。
            concurrency: config.mediaProcessingConcurrency,
          },
        )
      : undefined;
    if (!mediaWorker) {
      logger.warn(
        "Vision Runtime is not configured; media descriptions remain queued",
      );
    }
    // 媒体处理任务失败处理
    mediaWorker?.on("failed", (job, error) => {
      logger.error(
        { err: error, jobId: job?.id },
        "Media processing attempt failed",
      );
      // 重试耗尽后标记媒体资产状态为失败（DB 抖动时不得让 worker 崩溃）
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void postgres.db
          .update(schema.mediaAssets)
          .set({ status: "failed", errorCode: "retry_exhausted" })
          .where(eq(schema.mediaAssets.mediaId, job.data.businessEntityId))
          .catch((updateError: unknown) => {
            logger.error(
              { err: updateError, jobId: job.id },
              "Failed to mark media asset as failed",
            );
          });
      }
    });
    return () => {
      void mediaWorker?.close();
    };
  },
});

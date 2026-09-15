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
import { startConversationEventBus } from "../../infrastructure/events/conversation-events.js";
import * as schema from "../../infrastructure/postgres/schema.js";
import { MimoVisionClient } from "../../infrastructure/model_runtime/mimo-vision-client.js";
import { MimoAudioClient } from "../../infrastructure/model_runtime/mimo-audio-client.js";
import { processImageDescription } from "../../modules/media/application/process-image-description.js";
import { processVoiceTranscription } from "../../modules/media/application/process-voice-transcription.js";
import {
  resolveAsrSlotEndpoint,
  resolveVisionEndpoint,
  resolveVoiceToolchainPaths,
} from "../../modules/media/application/endpoint-resolution.js";
import { AudioTranscriptionsClient } from "../../infrastructure/model_runtime/audio-transcriptions-client.js";

/**
 * 识图执行模型分流（模型网关 R2）——主力/视觉槽位分界规则：
 * 1) 主力文本槽位模型带 vision 能力标签 → 直接用主力模型识图，不经过视觉槽位；
 * 2) 否则用视觉槽位绑定的模型（专用视觉小模型兜底）；
 * 3) 网关未绑定启用模型 → undefined（回落 .env 种子端点）。
 * 描述结果一次性落库（media_assets.description），后续对话复用文字不重复调用。
 */
await runProcess({
  name: "ingestion-worker",
  healthPort: (config) => config.ingestionWorkerHealthPort,
  start: ({ config, logger, postgres }) => {
    // 跨进程事件总线（只发布）：媒体转写/描述落库后广播 conversation_updated，
    // 让工作台不用等下一次对账就能看到转写结果。
    const stopConversationEventBus = startConversationEventBus({
      redisUrl: config.redisUrl,
      logger,
      subscribe: false,
    });
    // 初始化本地文件存储，用于读取媒体文件
    const mediaStorage = new LocalFileStorage(
      `${config.fileStorageRoot}/media`,
    );
    const vision = config.vision;
    // 专用 ASR 端点（OpenAI 兼容 audio/transcriptions，如硅基流动）
    const asr = config.asr;
    // 媒体消费者常驻（配置收敛）：入队闸门在 api 侧（env 或槽位绑定），
    // 消费端不该有第二套门禁；未配置时收到任务按防护分支记错退出。
    const mediaWorker = new Worker<JobEnvelope>(
      MEDIA_PROCESSING_QUEUE,
      async (job) => {
        if (job.data.jobType === "media.transcribe_voice") {
          // 语音转写：读取 SILK → 平台转码器产出 MP3 → ASR → 持久化描述。
          // 工具链路径与 ASR 端点解析策略在 modules/media（endpoint-resolution）。
          const { pythonPath, ffmpegPath } = resolveVoiceToolchainPaths();
          // ASR 端点分流（配置收敛：asr 槽位是唯一事实源）：
          // 槽位绑定 → 按注册条目 protocol 分流（audio_transcriptions
          // multipart / chat_completions 内联音频）；
          // 未绑槽位回落 .env——config.asr（专用 audio/transcriptions
          // 端点）优先，其次视觉端点内联音频。
          const asrSlot = await resolveAsrSlotEndpoint(postgres.db, logger);
          const fallbackVision = asrSlot || asr ? undefined : vision;
          if (!asrSlot && !asr && !fallbackVision) {
            logger.error(
              { jobId: job.data.jobId },
              "voice job received but no ASR endpoint configured (slot or env)",
            );
            return;
          }
          // asr 槽位协议分流：audio_transcriptions 走标准 multipart 端点
          // （如硅基流动）；chat_inline 走 chat/completions 内联音频（MiMo）。
          const audioClient = asrSlot
            ? asrSlot.protocol === "audio_transcriptions"
              ? new AudioTranscriptionsClient({
                  baseUrl: asrSlot.baseUrl,
                  apiKey: asrSlot.apiKey ?? "",
                  model: asrSlot.displayName,
                  timeoutMs: asrSlot.timeoutMs,
                })
              : new MimoAudioClient({
                  baseUrl: asrSlot.baseUrl,
                  apiKey: asrSlot.apiKey ?? "",
                  model: asrSlot.displayName,
                  timeoutMs: asrSlot.timeoutMs,
                })
            : asr
              ? new AudioTranscriptionsClient({
                  baseUrl: asr.baseUrl,
                  apiKey: asr.apiKey,
                  model: asr.model,
                  timeoutMs: asr.timeoutMs,
                })
              : new MimoAudioClient({
                  baseUrl: fallbackVision?.baseUrl ?? "",
                  apiKey: fallbackVision?.apiKey ?? "",
                  model: fallbackVision?.asrModel ?? "",
                  timeoutMs: fallbackVision?.timeoutMs ?? 60_000,
                });
          await processVoiceTranscription(
            postgres.db,
            mediaStorage,
            audioClient,
            asrSlot?.displayName ??
              asr?.model ??
              fallbackVision?.asrModel ??
              "mimo-v2.5",
            job.data.businessEntityId,
            {
              transcoder: new PysilkFfmpegTranscoder({
                ...(pythonPath && { pythonPath }),
                ...(ffmpegPath && { ffmpegPath }),
                onDiagnostics: (line) => {
                  logger.debug({ line }, "audio transcode diagnostics");
                },
              }),
            },
          );
          return;
        }
        // 图片描述：识图模型按能力分流（主力带视觉→主力；否则视觉槽位；
        // 均未绑回落 .env 种子）→ 读取图片 → 调用视觉模型 → 持久化描述
        const visionEndpoint = await resolveVisionEndpoint(postgres.db, logger);
        logger.info(
          { endpoint: visionEndpoint?.modelId ?? "legacy-seed" },
          "vision route decided",
        );
        if (visionEndpoint) {
          await processImageDescription(
            postgres.db,
            mediaStorage,
            new MimoVisionClient({
              baseUrl: visionEndpoint.baseUrl,
              apiKey: visionEndpoint.apiKey ?? "",
              model: visionEndpoint.displayName,
              timeoutMs: visionEndpoint.timeoutMs,
            }),
            visionEndpoint.displayName,
            job.data.businessEntityId,
          );
          return;
        }
        if (!visionEndpoint && !vision) {
          logger.error(
            { jobId: job.data.jobId },
            "image job received but no vision endpoint configured (slot or env)",
          );
          return;
        }
        const fallbackName = vision?.name ?? "mimo-v2.5";
        await processImageDescription(
          postgres.db,
          mediaStorage,
          new MimoVisionClient({
            baseUrl: vision?.baseUrl ?? "",
            apiKey: vision?.apiKey ?? "",
            model: fallbackName,
            timeoutMs: vision?.timeoutMs ?? 60_000,
          }),
          fallbackName,
          job.data.businessEntityId,
        );
      },
      {
        connection: bullMqConnection(config.redisUrl),
        // 并发由 MEDIA_PROCESSING_CONCURRENCY 控制：默认 1 避免多模态模型过载，
        // 50 并发会话场景下大量图片/语音同时到达时可按模型承载上调。
        concurrency: config.mediaProcessingConcurrency,
      },
    );
    // 媒体处理任务失败处理
    mediaWorker.on("failed", (job, error) => {
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
      stopConversationEventBus();
    };
  },
});

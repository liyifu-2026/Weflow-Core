/**
 * 媒体摄入 Worker 进程入口
 *
 * 职责：
 * - 从 Redis 队列消费媒体处理任务
 * - 图片：使用视觉模型（MimoVision）生成文字描述
 * - 将结果持久化到数据库，供后续对话上下文使用
 */
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { LocalFileStorage } from "../../infrastructure/file_storage/local-file-storage.js";
import { MEDIA_PROCESSING_QUEUE } from "../../infrastructure/redis/media-processing-dispatcher.js";
import {
  bullMqConnection,
  type JobEnvelope,
} from "../../infrastructure/redis/job-queue.js";
import { runProcess } from "../../infrastructure/runtime/run-process.js";
import * as schema from "../../infrastructure/postgres/schema.js";
import { MimoVisionClient } from "../../infrastructure/model_runtime/mimo-vision-client.js";
import { processImageDescription } from "../../modules/media/application/process-image-description.js";
import { readRuntimeSettings } from "../../modules/operations/application/runtime-settings.js";

await runProcess({
  name: "ingestion-worker",
  healthPort: (config) => config.ingestionWorkerHealthPort,
  start: ({ config, logger, postgres }) => {
    // 初始化本地文件存储，用于读取媒体文件
    const mediaStorage = new LocalFileStorage(
      `${config.fileStorageRoot}/media`,
    );
    const vision = config.vision;
    // 仅在配置了视觉模型时创建图片工作队列消费者
    const mediaWorker = vision
      ? new Worker<JobEnvelope>(
          MEDIA_PROCESSING_QUEUE,
          async (job) => {
            // 运行时模型选择：切换 vision_model 无需重启
            const runtime = await readRuntimeSettings(postgres.db);
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

/**
 * BullMQ 作业队列工厂
 * 创建和配置 BullMQ 队列实例，用于异步任务处理
 */
import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

/** 作业信封类型，包含作业元数据和追踪信息 */
export type JobEnvelope = {
  jobId: string;
  jobType: string;
  ownerModule: string;
  businessEntityId: string;
  idempotencyKey: string;
  attempt: number;
  traceId: string;
  createdAt: string;
};

/** 创建 BullMQ Redis 连接配置 */
export function bullMqConnection(redisUrl: string): ConnectionOptions {
  return {
    url: redisUrl,
    maxRetriesPerRequest: null,
  };
}

/**
 * 创建 BullMQ 作业队列
 * @param queueName - 队列名称
 * @param redisUrl - Redis 连接字符串
 * @returns BullMQ 队列实例
 */
export function createJobQueue(
  queueName: string,
  redisUrl: string,
): Queue<JobEnvelope> {
  const defaultJobOptions: JobsOptions = {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2_000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  };

  return new Queue<JobEnvelope>(queueName, {
    connection: bullMqConnection(redisUrl),
    defaultJobOptions,
  });
}

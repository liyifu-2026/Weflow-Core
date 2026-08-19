/**
 * 记忆捕获分发器
 * 从 PostgreSQL 读取已调度或运行中的记忆捕获状态，推入 Redis 队列
 * 使用 conversationId + revision 生成幂等的 Job ID
 * 支持从 idempotencyKey 中提取 revision 用于状态追踪
 */
import { createHash } from "node:crypto";
import { and, asc, inArray, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import * as schema from "../postgres/schema.js";
import { createJobQueue, type JobEnvelope } from "./job-queue.js";

/** 记忆捕获队列名称 */
export const MEMORY_CAPTURE_QUEUE = "memory-capture";

/** 启动记忆捕获分发器 */
export function startMemoryCaptureDispatcher(options: {
  db: NodePgDatabase<typeof schema>;
  redisUrl: string;
  logger: Logger;
  intervalMs?: number;
  now?: () => Date;
}): () => void {
  const queue = createJobQueue(MEMORY_CAPTURE_QUEUE, options.redisUrl);
  const abortController = new AbortController();

  const run = async (): Promise<void> => {
    while (!abortController.signal.aborted) {
      try {
        const now = options.now?.() ?? new Date();
        const states = await options.db
          .select()
          .from(schema.memoryCaptureStates)
          .where(
            and(
              inArray(schema.memoryCaptureStates.status, [
                "scheduled",
                "running",
              ]),
              lte(schema.memoryCaptureStates.scheduledAt, now),
            ),
          )
          .orderBy(asc(schema.memoryCaptureStates.scheduledAt))
          .limit(100);
        for (const state of states) {
          const jobId = memoryCaptureJobId(
            state.conversationId,
            state.revision,
          );
          const envelope: JobEnvelope = {
            jobId,
            jobType: "memory.capture",
            ownerModule: "memory",
            businessEntityId: state.conversationId,
            idempotencyKey: `${state.conversationId}\0${String(state.revision)}`,
            attempt: state.attempt,
            traceId: `memory-capture:${state.conversationId}:${String(state.revision)}`,
            createdAt: state.updatedAt.toISOString(),
          };
          await queue.add("memory.capture", envelope, { jobId });
        }
      } catch (error) {
        options.logger.error({ err: error }, "Memory capture dispatch failed");
      }
      await wait(options.intervalMs ?? 1_000, abortController.signal);
    }
  };

  void run();
  return () => {
    abortController.abort();
    void queue.close();
  };
}

/** 为记忆捕获生成稳定的 Job ID（基于 conversationId + revision） */
export function memoryCaptureJobId(
  conversationId: string,
  revision: number,
): string {
  return `memory_${createHash("sha256")
    .update(`${conversationId}\0${String(revision)}`)
    .digest("hex")}`;
}

/** 从 Job Envelope 的 idempotencyKey 中提取 revision 版本号 */
export function memoryCaptureRevision(envelope: JobEnvelope): number {
  const separator = envelope.idempotencyKey.lastIndexOf("\0");
  const revision = Number(envelope.idempotencyKey.slice(separator + 1));
  if (separator < 0 || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("invalid memory capture revision");
  }
  return revision;
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

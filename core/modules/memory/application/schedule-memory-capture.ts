/**
 * 记忆捕获调度
 *
 * 在会话安静窗口（90 秒）后安排记忆提取任务。
 * 使用 upsert 模式确保同一会话只有一个待处理的捕获任务，
 * 新消息到达时会重置调度时间和状态。
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";

/** 记忆捕获的安静窗口时间（毫秒），在此期间无新消息后才触发提取 */
export const MEMORY_QUIET_WINDOW_MS = 90_000;

type DatabaseTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

/** 调度记忆捕获任务（独立数据库连接） */
export async function scheduleMemoryCapture(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    contactId: string;
    watermarkMessageId: string;
    now?: Date;
  },
): Promise<void> {
  await persistMemoryCapture(db, input);
}

/** 在已有事务中调度记忆捕获任务 */
export async function scheduleMemoryCaptureInTransaction(
  transaction: DatabaseTransaction,
  input: {
    conversationId: string;
    contactId: string;
    watermarkMessageId: string;
    now?: Date;
  },
): Promise<void> {
  await persistMemoryCapture(transaction, input);
}

async function persistMemoryCapture(
  db: NodePgDatabase<typeof schema> | DatabaseTransaction,
  input: {
    conversationId: string;
    contactId: string;
    watermarkMessageId: string;
    now?: Date;
  },
): Promise<void> {
  // memory_enabled OFF：不调度捕获（recall 侧见 agent-context）
  const runtime = await readRuntimeSettings(db);
  if (!runtime.memoryEnabled) return;
  const now = input.now ?? new Date();
  const scheduledAt = new Date(now.getTime() + MEMORY_QUIET_WINDOW_MS);
  await db
    .insert(schema.memoryCaptureStates)
    .values({
      conversationId: input.conversationId,
      contactId: input.contactId,
      watermarkMessageId: input.watermarkMessageId,
      scheduledAt,
      status: "scheduled",
    })
    .onConflictDoUpdate({
      target: schema.memoryCaptureStates.conversationId,
      set: {
        contactId: input.contactId,
        watermarkMessageId: input.watermarkMessageId,
        scheduledAt,
        status: "scheduled",
        attempt: 0,
        errorCode: null,
        extractedCount: 0,
        revision: sql`${schema.memoryCaptureStates.revision} + 1`,
        updatedAt: now,
      },
    });
}

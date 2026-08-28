import { capability } from "../kernel/index.js";
import type { TextModel } from "../../../modules/model/contracts/text-model.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";

/** 记忆捕获能力：异步提取并持久化对话记忆（ADR/D6：记忆插件化下沉）。 */
export type MemoryCaptureService = {
  process(db: NodePgDatabase<typeof schema>, job: {
    conversationId: string;
    revision: number;
  }): Promise<"completed" | "stale">;
};

export const MEMORY_CAPTURE_CAPABILITY = capability<MemoryCaptureService>(
  "memory.capture",
);

/** 记忆召回能力：为 Agent 上下文组装提供历史记忆。 */
export type MemoryRecallService = {
  recall(db: NodePgDatabase<typeof schema>, conversationId: string, limit?: number): Promise<unknown[]>;
};

export const MEMORY_RECALL_CAPABILITY = capability<MemoryRecallService>(
  "memory.recall",
);

export type { TextModel };

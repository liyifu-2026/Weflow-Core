/**
 * Memory capability plugin (D6: 记忆模块插件化下沉).
 *
 * Registers capture/recall services into the RuntimeKernel so consumers
 * (agent-worker, agent context assembly) depend on capability tokens instead
 * of importing memory application modules directly. The implementation stays
 * in `modules/memory/application`; this plugin is the composition seam.
 */
import type { PluginDefinition, PluginContext } from "../kernel/index.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import type { TextModel } from "../../../modules/model/contracts/text-model.js";
import { TEXT_MODEL_CAPABILITY } from "../capabilities/text-model.js";
import {
  MEMORY_CAPTURE_CAPABILITY,
  MEMORY_RECALL_CAPABILITY,
  type MemoryCaptureService,
  type MemoryRecallService,
} from "../capabilities/memory.js";
import { processMemoryCapture } from "../../../modules/memory/application/process-memory-capture.js";
import { recallMemories } from "../../../modules/memory/application/recall-memories.js";

export type MemoryPluginOptions = {
  db: NodePgDatabase<typeof schema>;
  modelClient: TextModel;
  model: string;
};

/** 创建记忆能力插件；依赖 text.model 能力（由组合根注入）。 */
export function memoryPlugin(
  options: MemoryPluginOptions,
): PluginDefinition {
  const capture: MemoryCaptureService = {
    process: (db, job) =>
      processMemoryCapture(db, options.modelClient, options.model, job),
  };
  const recall: MemoryRecallService = {
    recall: (db, conversationId, limit) =>
      recallMemories(db, conversationId, limit),
  };
  return {
    name: "weflow-memory",
    provides: [MEMORY_CAPTURE_CAPABILITY, MEMORY_RECALL_CAPABILITY],
    requires: [TEXT_MODEL_CAPABILITY],
    setup: (context: PluginContext) => {
      context.provide(MEMORY_CAPTURE_CAPABILITY, capture);
      context.provide(MEMORY_RECALL_CAPABILITY, recall);
    },
  };
}

export { MEMORY_CAPTURE_CAPABILITY, MEMORY_RECALL_CAPABILITY };
export type { MemoryCaptureService, MemoryRecallService };

/**
 * 工具计划执行模块。
 *
 * Agent application owns the decision to execute a plan. ToolExecutionService
 * owns the persisted execution lifecycle; this module only adapts the current
 * tool dispatch to that boundary.
 */

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { KnowledgeSearch } from "../../knowledge/contracts/knowledge-search.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";
import {
  ToolExecutionService,
  type ToolExecutionRecord,
} from "./tool-execution-service.js";

/** 工具执行结果 */
export type ToolExecutionResult = {
  status: "succeeded" | "failed" | "already_completed" | "not_claimable";
  result?: Record<string, unknown>;
  errorCode?: string;
};

/** Minimal executor seam; a formal ToolRegistry is intentionally out of scope. */
export type ToolExecutor = (
  execution: ToolExecutionRecord,
) => Promise<Record<string, unknown>>;

export type ExecuteToolPlanDependencies = {
  knowledgeSearch?: KnowledgeSearch | undefined;
  executor?: ToolExecutor | undefined;
};

/** Executes one persisted plan. Repeating the same execution is idempotent. */
export async function executeToolPlan(
  db: NodePgDatabase<typeof schema>,
  executionId: string,
  dependencies: ExecuteToolPlanDependencies = {},
): Promise<ToolExecutionResult> {
  const service = new ToolExecutionService(db);
  const claim = await service.claim(executionId);
  if (claim.status === "already_completed") {
    return { status: "already_completed", result: claim.result };
  }
  if (claim.status === "not_claimable") {
    return { status: "not_claimable", errorCode: claim.errorCode };
  }

  try {
    const result = dependencies.executor
      ? await dependencies.executor(claim.execution)
      : await executeCurrentTool(
          db,
          claim.execution,
          dependencies.knowledgeSearch,
        );
    return await service.complete(
      executionId,
      result,
      claim.execution.claimedAt,
    );
  } catch (error) {
    const errorCode =
      error instanceof Error ? error.message.slice(0, 200) : "tool_failed";
    return await service.fail(
      executionId,
      errorCode,
      claim.execution.claimedAt,
    );
  }
}

/** Current dispatch only; tool definitions/registry remain a later slice. */
async function executeCurrentTool(
  db: NodePgDatabase<typeof schema>,
  execution: ToolExecutionRecord,
  knowledgeSearch: KnowledgeSearch | undefined,
): Promise<Record<string, unknown>> {
  if (execution.toolName === "query_contact_profile") {
    const profiles = await db
      .select({
        contactId: schema.contactProfiles.contactId,
        channel: schema.contactProfiles.channel,
        note: schema.contactProfiles.note,
        tags: schema.contactProfiles.tags,
      })
      .from(schema.contactProfiles)
      .innerJoin(
        schema.conversations,
        eq(schema.conversations.contactId, schema.contactProfiles.contactId),
      )
      .where(eq(schema.conversations.conversationId, execution.conversationId))
      .limit(1);
    return { profile: profiles[0] ?? null };
  }

  if (execution.toolName === "retrieve_knowledge") {
    const query = execution.arguments.query;
    if (typeof query !== "string" || !query.trim()) {
      throw new Error("invalid_knowledge_query");
    }
    // Existing behavior: disabled retrieval is a successful empty snapshot.
    const runtime = await readRuntimeSettings(db);
    if (!runtime.knowledgeEnabled) {
      return {
        query,
        evidence: [],
        retrievedAt: new Date().toISOString(),
        disabled: true,
      };
    }
    if (!knowledgeSearch) throw new Error("weknora_not_configured");
    return {
      query,
      evidence: await knowledgeSearch.search({ query }),
      retrievedAt: new Date().toISOString(),
    };
  }

  throw new Error("tool_not_implemented");
}

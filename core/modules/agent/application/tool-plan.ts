/**
 * 工具计划模块
 *
 * 根据 Agent 决策构建工具执行计划，
 * 包括工具名称、参数和幂等键。
 */

import type { AgentDecision } from "./agent-decision.js";
import {
  isToolName,
  validateToolArguments,
  type ToolName,
} from "./tool-catalog.js";

/** 工具执行计划 */
export type ToolPlan = {
  name: ToolName;
  arguments: Record<string, string>;
  idempotencyKey: string;
};

/** 构建知识库检索的工具计划 */
export function knowledgeToolPlan(turnId: string, query: string): ToolPlan {
  return {
    name: "retrieve_knowledge",
    arguments: validateToolArguments("retrieve_knowledge", { query }),
    idempotencyKey: `agent-tool:${turnId}`,
  };
}

/**
 * 根据 Agent 决策获取工具计划
 * 仅当决策为 retrieve_knowledge 或 call_tool 时返回计划，否则返回 null
 */
export function getToolPlan(
  decision: AgentDecision,
  turnId: string,
): ToolPlan | null {
  if (decision.nextAction === "retrieve_knowledge") {
    return knowledgeToolPlan(turnId, decision.knowledgeQuery ?? "");
  }
  if (decision.nextAction !== "call_tool" || !decision.tool) return null;
  const name = decision.tool.name;
  // 工具名不在平台目录中时抛出异常，由调用方按校验失败处理
  if (!isToolName(name)) throw new Error("tool_not_in_catalog");
  return {
    name,
    arguments: validateToolArguments(name, decision.tool.arguments),
    idempotencyKey: `agent-tool:${turnId}`,
  };
}

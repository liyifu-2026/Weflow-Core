/**
 * 工具计划轮次处理模块（平台核心流程）
 *
 * 当 Agent 决策中包含工具调用（如知识库检索）时，
 * 先执行工具获取结果，再基于工具结果调用 LLM 生成最终回复。
 * 这是 processAgentTurn 的后续流程。
 *
 * 平台边界：与 process-agent-turn 一致，不内置任何 Solution 业务
 * 策略；Skill 的 afterKnowledge 输出仅作为不透明提示注入。
 */

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { TextModel } from "../../model/contracts/text-model.js";
import type { KnowledgeSearch } from "../../knowledge/contracts/knowledge-search.js";
import type { KnowledgeEvidence } from "../../knowledge/contracts/knowledge-search.js";
import { parseAgentDecision } from "./agent-decision.js";
import { executeToolPlan } from "./execute-tool-plan.js";
import { SYSTEM_PROMPT, resolveStrategy } from "./process-agent-turn.js";
import { completeAgentDecision } from "./complete-agent-decision.js";
import { buildAgentContext } from "./agent-context.js";
import { recordAgentTurnEvent } from "./agent-turn-events.js";
import { validateDecision, validateReplySegments } from "./policy-gate.js";
import {
  commitAgentTurnFailure,
  commitAgentTurnHandoff,
  commitAgentTurnNoAction,
  commitAgentTurnOutcome,
} from "./agent-turn-outcome-command.js";
import { agentActionToDecision } from "./agent-action-to-decision.js";
import type { SkillRegistry } from "../contracts/agent-skill.js";
import type { ExecutionStrategyRegistry } from "../contracts/execution-strategy.js";

/**
 * 处理已规划工具的轮次
 * 执行工具 → 基于工具结果生成最终回复 → 持久化消息
 */
export async function processPlannedToolTurn(
  db: NodePgDatabase<typeof schema>,
  client: TextModel,
  model: string,
  turnId: string,
  traceId: string,
  knowledgeSearch?: KnowledgeSearch,
  skillRegistry?: SkillRegistry,
  strategyRegistry?: ExecutionStrategyRegistry,
): Promise<void> {
  // 查询待执行的工具计划（planned 或已成功但后续模型调用失败需要重试的）
  const executions = await db
    .select()
    .from(schema.toolExecutions)
    .where(eq(schema.toolExecutions.turnId, turnId))
    .limit(1);
  const execution = executions[0];
  if (!execution) {
    const conversationId = await getConversationId(db, turnId);
    await commitAgentTurnFailure(db, {
      conversationId,
      turnId,
      errorCode: "tool_checkpoint_missing",
      handoffReason:
        "tool_checkpoint_missing: persisted tool plan is unavailable",
      events: [
        {
          eventType: "validation_failed",
          reasonCode: "tool_checkpoint_missing",
        },
      ],
    });
    return;
  }
  if (execution.status === "failed") {
    const errorCode = execution.errorCode ?? "tool_execution_failed";
    await commitAgentTurnFailure(db, {
      conversationId: execution.conversationId,
      turnId,
      errorCode,
      handoffReason: `tool_failure: ${errorCode}`,
    });
    return;
  }
  // 执行工具计划（幂等：重复执行同一工具不会产生副作用）
  const toolResult = await executeToolPlan(db, execution.executionId, {
    knowledgeSearch,
  });
  await recordAgentTurnEvent(db, {
    turnId,
    conversationId: execution.conversationId,
    eventType: "tool_completed",
    reasonCode:
      toolResult.status === "succeeded" ||
      toolResult.status === "already_completed"
        ? undefined
        : (toolResult.errorCode ?? "tool_failed"),
    payload: { toolName: execution.toolName, status: toolResult.status },
  });
  // Another worker owns the current lease (or reclaimed it after this worker
  // became stale). The late worker must not create a duplicate Handoff or
  // overwrite the AgentTurn owned by the newer execution.
  if (toolResult.status === "not_claimable") return;
  // 工具执行失败时触发转人工
  if (
    toolResult.status !== "succeeded" &&
    toolResult.status !== "already_completed"
  ) {
    const errorCode = toolResult.errorCode ?? "tool_failed";
    await commitAgentTurnFailure(db, {
      conversationId: execution.conversationId,
      turnId,
      errorCode,
      handoffReason: `tool_failure: ${errorCode}`,
    });
    return;
  }

  // 基于工具结果重新构建上下文，再次调用 LLM 生成最终回复
  const context = await buildAgentContext(db, execution.conversationId);
  const recentUserMessages = context.history
    .filter((message) => message.role === "user")
    .map((message) => message.content);
  const evidenceList =
    execution.toolName === "retrieve_knowledge" &&
    Array.isArray(toolResult.result?.evidence)
      ? (toolResult.result.evidence as KnowledgeEvidence[])
      : [];
  // Skill 提示：注册 Skill 的 afterKnowledge 输出作为不透明上下文注入
  const skillHints: string[] = [];
  if (skillRegistry) {
    for (const skill of skillRegistry.list()) {
      if (!skill.afterKnowledge) continue;
      try {
        const hint = skill.afterKnowledge({
          evidence: evidenceList,
          currentMessage: recentUserMessages.at(-1),
          recentUserMessages,
          now: new Date().toISOString(),
        });
        if (hint !== undefined) {
          skillHints.push(
            `${skill.id}@${skill.version}: ${JSON.stringify(hint)}`,
          );
        }
      } catch {
        // 单个 Skill 异常不影响轮次处理
      }
    }
  }
  const skillHintSection =
    skillHints.length > 0
      ? `\n\n技能提示（由已安装的 Solution Skill 提供，可参考但不得向对方复述）：\n${skillHints.join("\n")}`
      : "";

  const turns = await db
    .select({
      executionProfileId: schema.agentTurns.executionProfileId,
    })
    .from(schema.agentTurns)
    .where(eq(schema.agentTurns.turnId, turnId))
    .limit(1);
  const strategy = await resolveStrategy(
    db,
    { executionProfileId: turns[0]?.executionProfileId ?? null },
    strategyRegistry,
  );
  const strategySystem = strategy
    ? strategy.buildModelRequest({
        conversationId: execution.conversationId,
        contactId: "",
        messages: context.history,
        facts: {},
        availableTools: [],
      }).system
    : SYSTEM_PROMPT(true);

  const response = await completeAgentDecision(
    client,
    [
      {
        role: "system",
        content: `${strategySystem}${context.prompt}\n工具执行结果（可信事实）：${JSON.stringify(toolResult.result ?? {})}${skillHintSection}\n请基于工具结果生成自然语言或结构化最终决策；不得依据常识补全工具结果或声称执行了尚未执行的动作。next_action 必须为 reply、ask_for_information、handoff 或 no_action，不得再次调用工具。`,
      },
      ...context.history,
    ],
    model,
  );
  const decision = strategy
    ? agentActionToDecision(strategy.parseModelResponse({ text: response }))
    : parseAgentDecision(response);
  const gate = validateDecision(decision);
  if (gate.action === "handoff") {
    await commitAgentTurnHandoff(db, {
      conversationId: execution.conversationId,
      turnId,
      reason: `policy_gate_after_tool: ${gate.reasonCode}`,
    });
    return;
  }
  // 防止工具链过长：一轮只允许一次工具调用
  if (
    decision.nextAction === "call_tool" ||
    decision.nextAction === "retrieve_knowledge"
  ) {
    await commitAgentTurnFailure(db, {
      conversationId: execution.conversationId,
      turnId,
      errorCode: "tool_chain_limit",
      handoffReason: "tool_chain_limit: reached maximum steps for one turn",
    });
    return;
  }
  if (
    decision.requiresHuman ||
    decision.riskLevel === "high" ||
    decision.nextAction === "handoff"
  ) {
    await commitAgentTurnHandoff(db, {
      conversationId: execution.conversationId,
      turnId,
      reason: "agent_recommended_after_tool: insufficient safe resolution",
    });
    return;
  }
  if (decision.nextAction === "no_action") {
    await commitAgentTurnNoAction(db, {
      conversationId: execution.conversationId,
      turnId,
      reason: decision.noActionReason ?? "no_action",
    });
    return;
  }
  try {
    validateReplySegments(decision.replySegments);
  } catch (error) {
    const reasonCode =
      error instanceof Error ? error.message : "reply_validation_failed";
    await commitAgentTurnFailure(db, {
      conversationId: execution.conversationId,
      turnId,
      errorCode: "reply_validation_failed",
      events: [{ eventType: "validation_failed", reasonCode }],
    });
    return;
  }
  await commitAgentTurnOutcome(db, {
    conversationId: execution.conversationId,
    turnId,
    traceId,
    variant: "tool_result",
    responseText: decision.replyText,
    responseSegments: decision.replySegments,
    model,
    memoryWatermarkMessageId: `agent-message:${turnId}:tool-result:${String(decision.replySegments.length)}`,
  });
}

async function getConversationId(
  db: NodePgDatabase<typeof schema>,
  turnId: string,
): Promise<string> {
  const row = await db
    .select({ conversationId: schema.agentTurns.conversationId })
    .from(schema.agentTurns)
    .where(eq(schema.agentTurns.turnId, turnId))
    .limit(1);
  if (!row[0]) throw new Error(`agent turn ${turnId} does not exist`);
  return row[0].conversationId;
}

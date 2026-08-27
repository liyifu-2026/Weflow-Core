/**
 * Agent Turn 编排层（TurnRunner）：
 * - processAgentTurn：全新决策路径（策略评估 → 上下文 → LLM 决策 → 动作）
 * - processPlannedToolTurn：工具检查点恢复路径（执行工具 → 最终回复）
 *
 * 只做编排，不做纯决策（决策在 reply-policy / turn-utils）；
 * 仅由 AgentTurnExecutor.execute() 在完成 CAS 领取后调用（ADR-0001）。
 */

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { TextModel } from "../../model/contracts/text-model.js";
import type {
  KnowledgeEvidence,
  KnowledgeSearch,
} from "../../knowledge/contracts/knowledge-search.js";
import type { SkillRegistry } from "../contracts/agent-skill.js";
import type { ExecutionStrategyRegistry } from "../contracts/execution-strategy.js";
import { evaluateReplyPolicy, buildSystemPrompt, resolveExecutionStrategy, collectSkillHints, collectSkillHintsAfterKnowledge } from "./reply-policy.js";
import { parseAgentDecision } from "./agent-decision.js";
import { agentActionToDecision } from "./agent-action-to-decision.js";
import { getToolPlan, knowledgeToolPlan } from "./tool-plan.js";
import { buildHandoffBriefing } from "../../handoff/application/handoff-briefing.js";
import { completeAgentDecision } from "./complete-agent-decision.js";
import { AgentTurnTransitionNotApplied } from "./agent-turn-service.js";
import { recordAgentTurnEvent } from "./agent-turn-events.js";
import { validateDecision, validateReplySegments } from "./policy-gate.js";
import { buildAgentContext } from "./agent-context.js";
import { executeToolPlan } from "./execute-tool-plan.js";
import {
  commitAgentTurnOutcome,
  commitAgentTurnFailure,
  commitAgentTurnHandoff,
  commitAgentTurnNoAction,
  commitAgentTurnSuppression,
  commitAgentTurnSuperseded,
  persistAgentToolCheckpoint,
} from "./agent-turn-outcome-command.js";
import {
  classifyError,
  detectChatType,
  getAgentTurnConversationId,
  hasNewerAgentTurn,
} from "./turn-utils.js";
import type { AgentTurnExecutionInput } from "./agent-turn-executor.js";

type Database = NodePgDatabase<typeof schema>;

export type TurnRunnerDependencies = {
  knowledgeSearch?: KnowledgeSearch | undefined;
  skillRegistry?: SkillRegistry | undefined;
  strategyRegistry?: ExecutionStrategyRegistry | undefined;
  /**
   * Optional hook called before strategy.buildModelRequest to pre-resolve
   * AI employee prompts from the database (populates strategy cache).
   */
  preResolveAiEmployeePrompt?: (
    contactId: string,
    conversationId: string,
  ) => Promise<void>;
};

/**
 * 处理一个 Agent 轮次的全新决策路径：
 * 策略评估 → 上下文构建 → LLM 决策 → 执行动作（回复/转人工/工具调用/静默）
 */
export async function processAgentTurn(
  db: Database,
  client: TextModel,
  model: string,
  job: AgentTurnExecutionInput,
  dependencies: TurnRunnerDependencies,
): Promise<void> {
  const turns = await db
    .select()
    .from(schema.agentTurns)
    .where(eq(schema.agentTurns.turnId, job.turnId))
    .limit(1);
  const turn = turns[0];
  if (!turn) throw new Error(`agent turn ${job.turnId} does not exist`);
  // 已完成或已被取代的轮次直接跳过
  if (turn.status === "completed" || turn.status === "superseded") return;

  // 轮次已由 AgentTurnExecutor 通过 AgentTurnService 完成 CAS 领取
  await recordAgentTurnEvent(db, {
    turnId: turn.turnId,
    conversationId: turn.conversationId,
    eventType: "ownership_checked",
    payload: { allowed: true },
  });

  // 评估回复策略：检查 Agent 是否被禁用或 Handoff 是否激活
  const policy = await evaluateReplyPolicy(db, turn.conversationId);
  if (policy.action === "ignore") {
    await commitAgentTurnSuppression(db, {
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      reason: policy.reason,
    });
    return;
  }

  const [conversation] = await db
    .select({
      revision: schema.conversations.revision,
      contactId: schema.conversations.contactId,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, turn.conversationId))
    .limit(1);
  const conversationRevision = conversation?.revision ?? 0;

  // 检测会话类型：conversationId 以 @chatroom 结尾表示群聊
  const chatType = detectChatType(turn.conversationId);

  // 构建 Agent 上下文（消息历史、记忆、上一人工周期摘要等）
  const context = await buildAgentContext(db, turn.conversationId, chatType);
  await recordAgentTurnEvent(db, {
    turnId: turn.turnId,
    conversationId: turn.conversationId,
    eventType: "context_built",
    payload: { historyCount: context.history.length },
  });

  try {
    // 解析执行策略：优先按执行 Profile 声明的 strategyRef，其次取注册表
    // 中已安装的第一个策略；都没有时使用内置通用 Prompt。
    const strategy = await resolveExecutionStrategy(
      db,
      turn,
      dependencies.strategyRegistry,
    );

    // AI 员工 Prompt 预解析：在策略的 buildModelRequest 之前异步查询数据库，
    // 将已发布的 AI 员工 prompt 填充到策略缓存中。
    if (dependencies.preResolveAiEmployeePrompt) {
      await dependencies.preResolveAiEmployeePrompt(
        conversation?.contactId ?? "",
        turn.conversationId,
      );
    }

    const strategySystem = strategy
      ? strategy.buildModelRequest({
          conversationId: turn.conversationId,
          contactId: conversation?.contactId ?? "",
          messages: context.history,
          facts: {},
          availableTools: [
            ...(dependencies.knowledgeSearch ? ["retrieve_knowledge"] : []),
            "query_contact_profile",
            "fetch_url",
          ],
          chatType,
        }).system
      : buildSystemPrompt(Boolean(dependencies.knowledgeSearch), chatType);

    // Skill 提示：SkillRegistry 中每个注册 Skill 的 beforeKnowledge 输出
    // 作为不透明上下文注入，平台不解释其内容。
    const skillHints = collectSkillHints(
      dependencies.skillRegistry,
      context.history,
    );
    const skillHintSection =
      skillHints.length > 0
        ? `\n\n技能提示（由已安装的 Solution Skill 提供，可参考但不得向对方复述）：\n${skillHints.join("\n")}`
        : "";

    // 调用 LLM 获取决策结果
    const modelResponse = await completeAgentDecision(
      client,
      [
        {
          role: "system",
          content: `${strategySystem}${context.prompt}${skillHintSection}`,
        },
        ...context.history,
      ],
      model,
    );
    const decision = strategy
      ? agentActionToDecision(
          strategy.parseModelResponse({ text: modelResponse }),
        )
      : parseAgentDecision(modelResponse);
    await recordAgentTurnEvent(db, {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      eventType: "policy_decided",
      payload: {
        action: decision.nextAction,
        riskLevel: decision.riskLevel,
      },
    });

    const gate = validateDecision(decision);
    if (gate.action === "handoff") {
      await commitAgentTurnHandoff(db, {
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        reason: gate.reasonCode,
        briefing: buildHandoffBriefing({
          sourceConversationRevision: conversationRevision,
          handoffReason: `policy_gate: ${gate.reasonCode}`,
          ...(decision.handoffBriefing
            ? { modelBriefing: decision.handoffBriefing }
            : {}),
        }),
      });
      return;
    }

    // 构建工具计划：retrieve_knowledge 或 call_tool；工具名不在平台
    // 工具目录中时视为校验失败，直接失败（不发送、不重试循环）。
    let toolPlan = null;
    if (decision.nextAction === "retrieve_knowledge") {
      toolPlan = knowledgeToolPlan(turn.turnId, decision.knowledgeQuery ?? "");
    } else if (decision.nextAction === "call_tool" && decision.tool) {
      try {
        toolPlan = getToolPlan(decision, turn.turnId);
      } catch {
        await commitAgentTurnFailure(db, {
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          errorCode: "invalid_tool_plan",
          events: [
            {
              eventType: "validation_failed",
              reasonCode: "invalid_tool_plan",
            },
          ],
        });
        return;
      }
    }

    // 检查是否有更新的轮次（防止处理已被取代的旧消息）
    if (await hasNewerAgentTurn(db, turn)) {
      await commitAgentTurnSuperseded(db, {
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        reason: "newer_turn_exists",
      });
      return;
    }

    // 需要转人工的情况：模型判断需要人工介入或高风险或明确要求转人工
    if (
      !toolPlan &&
      (decision.requiresHuman ||
        decision.riskLevel === "high" ||
        decision.nextAction === "handoff")
    ) {
      await commitAgentTurnHandoff(db, {
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        reason: "agent_recommended",
        briefing: buildHandoffBriefing({
          sourceConversationRevision: conversationRevision,
          handoffReason: `agent_recommended: ${decision.riskLevel}`,
          ...(decision.handoffBriefing
            ? { modelBriefing: decision.handoffBriefing }
            : {}),
        }),
      });
      return;
    }
    // no_action：模型判断当前无需任何操作，静默处理（记录原因）
    if (decision.nextAction === "no_action") {
      await commitAgentTurnNoAction(db, {
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        reason: decision.noActionReason ?? "no_action",
      });
      return;
    }

    if (decision.replySegments.length > 0) {
      try {
        validateReplySegments(decision.replySegments);
      } catch (error) {
        const reasonCode =
          error instanceof Error ? error.message : "reply_validation_failed";
        await commitAgentTurnFailure(db, {
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          errorCode: "reply_validation_failed",
          events: [{ eventType: "validation_failed", reasonCode }],
        });
        return;
      }
    }

    if (toolPlan) {
      await persistAgentToolCheckpoint(db, {
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        toolPlan,
      });
      return;
    }
    await commitAgentTurnOutcome(db, {
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      traceId: job.traceId,
      variant: "direct",
      responseText: decision.replyText,
      responseSegments: decision.replySegments,
      model,
      memoryWatermarkMessageId: `agent-message:${turn.turnId}:${String(decision.replySegments.length)}`,
    });
  } catch (error) {
    if (error instanceof AgentTurnTransitionNotApplied) throw error;
    // 异常时将轮次重置为 queued 状态，以便后续重试
    await db
      .update(schema.agentTurns)
      .set({
        status: "queued",
        errorCode: classifyError(error),
      })
      .where(
        and(
          eq(schema.agentTurns.turnId, turn.turnId),
          eq(schema.agentTurns.status, "running"),
        ),
      );
    throw error;
  }
}

/**
 * 处理已规划工具的轮次（工具检查点的恢复路径）：
 * 执行工具 → 基于工具结果生成最终回复 → 持久化消息
 */
export async function processPlannedToolTurn(
  db: Database,
  client: TextModel,
  model: string,
  turnId: string,
  traceId: string,
  knowledgeSearch?: KnowledgeSearch,
  skillRegistry?: SkillRegistry,
  strategyRegistry?: ExecutionStrategyRegistry,
  preResolveAiEmployeePrompt?: (
    contactId: string,
    conversationId: string,
  ) => Promise<void>,
): Promise<void> {
  // 查询待执行的工具计划（planned 或已成功但后续模型调用失败需要重试的）
  const executions = await db
    .select()
    .from(schema.toolExecutions)
    .where(eq(schema.toolExecutions.turnId, turnId))
    .limit(1);
  const execution = executions[0];
  if (!execution) {
    const conversationId = await getAgentTurnConversationId(db, turnId);
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

  // 检测会话类型：conversationId 以 @chatroom 结尾表示群聊
  const chatType = detectChatType(execution.conversationId);

  // 基于工具结果重新构建上下文，再次调用 LLM 生成最终回复
  const context = await buildAgentContext(db, execution.conversationId, chatType);
  const evidenceList =
    execution.toolName === "retrieve_knowledge" &&
    Array.isArray(toolResult.result?.evidence)
      ? (toolResult.result.evidence as KnowledgeEvidence[])
      : [];
  // Skill 提示：注册 Skill 的 afterKnowledge 输出作为不透明上下文注入
  const skillHints = collectSkillHintsAfterKnowledge(
    skillRegistry,
    evidenceList,
    context.history,
  );
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
  const [conversation] = await db
    .select({ contactId: schema.conversations.contactId })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, execution.conversationId))
    .limit(1);
  const strategy = await resolveExecutionStrategy(
    db,
    { executionProfileId: turns[0]?.executionProfileId ?? null },
    strategyRegistry,
  );

  // AI 员工 Prompt 预解析（工具恢复路径）
  if (preResolveAiEmployeePrompt) {
    await preResolveAiEmployeePrompt(
      conversation?.contactId ?? "",
      execution.conversationId,
    );
  }

  const strategySystem = strategy
    ? strategy.buildModelRequest({
        conversationId: execution.conversationId,
        contactId: conversation?.contactId ?? "",
        messages: context.history,
        facts: {},
        availableTools: [],
        chatType,
      }).system
    : buildSystemPrompt(true, chatType);

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

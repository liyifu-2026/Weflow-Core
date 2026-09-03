/**
 * Agent Turn 编排层（TurnRunner）：
 * - processAgentTurn：全新决策路径（策略评估 → 上下文 → LLM 决策 → 动作）
 * - processPlannedToolTurn：工具检查点恢复路径（执行工具 → 最终回复）
 *
 * 只做编排，不做纯决策（决策在 reply-policy / turn-utils）；
 * 决策后处理（gate/handoff/no_action/校验/落库）统一在 decision-disposition。
 * 仅由 AgentTurnExecutor.execute() 在完成 CAS 领取后调用（ADR-0001）。
 */

import { and, eq, inArray, sql } from "drizzle-orm";

/** 单个 Agent Turn 内允许的最大工具步数（有界 ReAct；1 = 旧版行为）。 */
export const MAX_TOOL_STEPS_PER_TURN = 4;
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { TextModel } from "../../model/contracts/text-model.js";
import type {
  KnowledgeEvidence,
  KnowledgeSearch,
} from "../../knowledge/contracts/knowledge-search.js";
import type { SkillRegistry } from "../contracts/agent-skill.js";
import type { ExecutionStrategyRegistry } from "../contracts/execution-strategy.js";
import {
  buildSystemPrompt,
  evaluateReplyPolicy,
  resolveExecutionStrategy,
  collectSkillHints,
  collectSkillHintsAfterKnowledge,
} from "./reply-policy.js";
import { parseAgentDecision } from "./agent-decision.js";
import { agentActionToDecision } from "./agent-action-to-decision.js";
import { executeToolPlan } from "./execute-tool-plan.js";
import {
  AgentTurnTransitionNotApplied,
} from "./agent-turn-service.js";
import {
  commitAgentTurnFailure,
  commitAgentTurnSuppression,
} from "./agent-turn-outcome-command.js";
import { recordAgentTurnEvent } from "./agent-turn-events.js";
import { buildAgentContext } from "./agent-context.js";
import { commitDecisionDisposition } from "./decision-disposition.js";
import {
  classifyError,
  detectChatType,
  getAgentTurnConversationId,
} from "./turn-utils.js";
import { completeAgentDecision } from "./complete-agent-decision.js";
import type { AgentTurnExecutionInput } from "./agent-turn-executor.js";

type Database = NodePgDatabase<typeof schema>;

export type TurnRunnerDependencies = {
  knowledgeSearch?: KnowledgeSearch | undefined;
  skillRegistry?: SkillRegistry | undefined;
  strategyRegistry?: ExecutionStrategyRegistry | undefined;
  /**
   * Optional hook called before strategy.buildModelRequest to pre-resolve
   * AI employee prompts from the database (populates strategy cache).
   * `triggerText` is optional and drives reception-plan keyword routing
   * inside the Solution strategy; Core stays business-neutral.
   */
  preResolveAiEmployeePrompt?: (
    contactId: string,
    conversationId: string,
    triggerText?: string | undefined,
  ) => Promise<void>;
  /**
   * Optional hook resolving the AI employee identity (opaque string, e.g. a
   * definition id) for the conversation. When it returns a value, that value
   * is persisted as messages.actor_id on the agent reply so every surface
   * (Console / Mobile) can render the employee's own avatar. Core never
   * interprets the identifier.
   */
  resolveAiEmployeeId?: (
    contactId: string,
    conversationId: string,
  ) => Promise<string | null | undefined>;
};

/**
 * 处理一个 Agent 轮次的全新决策路径：
 * 策略评估 → 上下文构建 → LLM 决策 → 统一决策后处理（decision-disposition）
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
    // 将已发布的 AI 员工 prompt 填充到策略缓存中。触发文本取最近一条
    // 入站消息内容，供 Solution 策略做接待编排的关键词路由。
    if (dependencies.preResolveAiEmployeePrompt) {
      await dependencies.preResolveAiEmployeePrompt(
        conversation?.contactId ?? "",
        turn.conversationId,
        lastInboundText(context.history),
      );
    }
    // AI 员工身份：命中时写入 messages.actor_id，前端据此渲染员工头像
    const aiEmployeeId = dependencies.resolveAiEmployeeId
      ? ((await dependencies.resolveAiEmployeeId(
          conversation?.contactId ?? "",
          turn.conversationId,
        )) ?? null)
      : null;

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
    const skillHintSection = skillHintBlock(
      collectSkillHints(dependencies.skillRegistry, context.history),
    );

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
          strategy.parseModelResponse({ text: modelResponse.text }),
        )
      : parseAgentDecision(modelResponse.text);
    await recordAgentTurnEvent(db, {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      eventType: "policy_decided",
      payload: {
        action: decision.nextAction,
        riskLevel: decision.riskLevel,
      },
    });

    // 决策后处理：gate → superseded → 工具计划 → no_action → 校验 → 落库
    await commitDecisionDisposition({
      decision,
      db,
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      traceId: job.traceId,
      path: "fresh",
      triggerMessageId: turn.triggerMessageId,
      conversationRevision: conversation?.revision ?? 0,
      model,
      aiEmployeeId,
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
 * 执行工具 → 基于工具结果重新决策 → 统一决策后处理（decision-disposition）
 */
export async function processPlannedToolTurn(
  db: Database,
  client: TextModel,
  model: string,
  job: AgentTurnExecutionInput,
  dependencies: TurnRunnerDependencies,
): Promise<void> {
  // 查询待执行的工具计划（planned 或已成功但后续模型调用失败需要重试的）
  const executions = await db
    .select()
    .from(schema.toolExecutions)
    .where(eq(schema.toolExecutions.turnId, job.turnId))
    .limit(1);
  const execution = executions[0];
  if (!execution) {
    const conversationId = await getAgentTurnConversationId(db, job.turnId);
    await commitAgentTurnFailure(db, {
      conversationId,
      turnId: job.turnId,
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
      turnId: job.turnId,
      errorCode,
      handoffReason: `tool_failure: ${errorCode}`,
    });
    return;
  }
  // 执行工具计划（幂等：重复执行同一工具不会产生副作用）
  const toolResult = await executeToolPlan(db, execution.executionId, {
    knowledgeSearch: dependencies.knowledgeSearch,
  });
  await recordAgentTurnEvent(db, {
    turnId: job.turnId,
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
      turnId: job.turnId,
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
  const skillHintSection = skillHintBlock(
    collectSkillHintsAfterKnowledge(
      dependencies.skillRegistry,
      evidenceList,
      context.history,
    ),
  );

  const turns = await db
    .select({
      executionProfileId: schema.agentTurns.executionProfileId,
    })
    .from(schema.agentTurns)
    .where(eq(schema.agentTurns.turnId, job.turnId))
    .limit(1);
  const [conversation] = await db
    .select({ contactId: schema.conversations.contactId })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, execution.conversationId))
    .limit(1);
  const strategy = await resolveExecutionStrategy(
    db,
    { executionProfileId: turns[0]?.executionProfileId ?? null },
    dependencies.strategyRegistry,
  );

  // AI 员工 Prompt 预解析（工具恢复路径）；触发文本取最近一条入站消息。
  if (dependencies.preResolveAiEmployeePrompt) {
    await dependencies.preResolveAiEmployeePrompt(
      conversation?.contactId ?? "",
      execution.conversationId,
      lastInboundText(context.history),
    );
  }
  // AI 员工身份（工具路径）：与主路径同语义，命中写入 actor_id
  const aiEmployeeId = dependencies.resolveAiEmployeeId
    ? ((await dependencies.resolveAiEmployeeId(
        conversation?.contactId ?? "",
        execution.conversationId,
      )) ?? null)
    : null;

  // 工具步数预算（Phase 2 有界 ReAct）：按本 turn 已完成的工具执行数计算。
  // 步数达到上限时提示词禁止再次调工具（与 disposition 预算判定一致）；
  // 未达上限时允许模型继续规划 retrieve_knowledge / call_tool。
  const completedToolSteps = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.toolExecutions)
    .where(
      and(
        eq(schema.toolExecutions.turnId, job.turnId),
        inArray(schema.toolExecutions.status, ["succeeded", "planned"]),
      ),
    );
  const toolStepsUsed = completedToolSteps[0]?.count ?? 1;
  const toolStepBudget = MAX_TOOL_STEPS_PER_TURN;
  const budgetExhausted = toolStepsUsed >= toolStepBudget;

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
        content: `${strategySystem}${context.prompt}\n工具执行结果（可信事实）：${JSON.stringify(toolResult.result ?? {})}${skillHintSection}\n请基于工具结果生成自然语言或结构化最终决策；不得依据常识补全工具结果或声称执行了尚未执行的动作。next_action 必须为 reply、ask_for_information、handoff、no_action、wait 或 end_session${budgetExhausted ? "，不得再次调用工具（工具步数预算已耗尽）" : "；确有必要时可再次调用 retrieve_knowledge 或 call_tool 继续查证"}。`,
      },
      ...context.history,
    ],
    model,
  );
  const decision = strategy
    ? agentActionToDecision(strategy.parseModelResponse({ text: response.text }))
    : parseAgentDecision(response.text);
  if (response.reasoning) {
    await recordAgentTurnEvent(db, {
      turnId: job.turnId,
      conversationId: execution.conversationId,
      eventType: "model_reasoning",
      payload: { reasoning: response.reasoning },
    });
  }

  // 决策后处理：gate → 工具步数预算 → no_action → 校验 → 落库
  await commitDecisionDisposition({
    decision,
    db,
    turnId: job.turnId,
    conversationId: execution.conversationId,
    traceId: job.traceId,
    path: "tool_recovery",
    conversationRevision: null,
    model,
    aiEmployeeId,
    toolStepsUsed,
    toolStepBudget,
  });
}

/**
 * 将 Skill 提示列表包装为 system prompt 注入块；空列表返回空串。
 */
function skillHintBlock(skillHints: string[]): string {
  return skillHints.length > 0
    ? `\n\n技能提示（由已安装的 Solution Skill 提供，可参考但不得向对方复述）：\n${skillHints.join("\n")}`
    : "";
}

/**
 * 取消息历史中最近一条入站（user 角色）文本，作为接待编排路由的触发文本。
 * 历史按时间升序，从尾部向前找；找不到（空会话/纯出站）返回 undefined，
 * 调用方按「无路由输入」处理。该辅助不理解任何业务关键词。
 */
export function lastInboundText(
  history: readonly { role: "user" | "assistant"; content: string }[],
): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message && message.role === "user" && message.content.trim() !== "") {
      return message.content;
    }
  }
  return undefined;
}

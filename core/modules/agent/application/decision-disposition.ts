/**
 * Decision disposition: shared post-processing for LLM decisions.
 *
 * Both Agent Turn execution paths — the fresh decision path
 * (processAgentTurn) and the tool-checkpoint recovery path
 * (processPlannedToolTurn) — previously duplicated the same tail:
 * policy gate → handoff → no_action → reply validation → tool
 * checkpoint or outcome commit. This module is the single owner of that
 * tail so the two paths cannot drift again.
 *
 * Deliberate normalisations (documented, covered by tests):
 * - Fresh path: the superseded check runs BEFORE tool-plan construction.
 *   A superseded turn no longer burns tool-plan validation or risks an
 *   invalid_tool_plan failure/handoff for a turn that must die anyway.
 * - The former `agent_recommended` handoff blocks after the gate were
 *   unreachable (validateDecision returns handoff for exactly
 *   requiresHuman || riskLevel === "high" || nextAction === "handoff",
 *   and the gate commits before those blocks could run). They are
 *   removed, not ported.
 *
 * This module commits outcomes; it never calls the model or tools.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { AgentDecision } from "./agent-decision.js";
import { getToolPlan, knowledgeToolPlan, type ToolPlan } from "./tool-plan.js";
import { validateDecision, validateReplySegments } from "./policy-gate.js";
import { buildHandoffBriefing } from "../../handoff/application/handoff-briefing.js";
import {
  commitAgentTurnFailure,
  commitAgentTurnHandoff,
  commitAgentTurnNoAction,
  commitAgentTurnOutcome,
  commitAgentTurnSuperseded,
  persistAgentToolCheckpoint,
} from "./agent-turn-outcome-command.js";
import { hasNewerAgentTurn } from "./turn-utils.js";
import {
  ensureSessionOnWait,
  scheduleSessionWake,
} from "./session-wake.js";

type Database = NodePgDatabase<typeof schema>;

/** Which execution path produced the decision. */
export type DecisionPath = "fresh" | "tool_recovery";

export type DecisionDispositionInput = {
  db: Database;
  decision: AgentDecision;
  turnId: string;
  conversationId: string;
  traceId: string;
  path: DecisionPath;
  /**
   * Fresh path only: enables the superseded check (newer trigger message).
   * The tool-recovery path has no superseded check and omits this field.
   */
  triggerMessageId?: string | undefined;
  /**
   * Fresh path only: conversation revision captured before the model call,
   * stamped into the handoff briefing. Tool-recovery passes null.
   */
  conversationRevision: number | null;
  model: string;
  /** AI 员工标识；非空时写入出站消息 actor_id。 */
  aiEmployeeId: string | null;
  /**
   * Tool-recovery path only: how many tool steps this turn has already
   * executed（含本次恢复前的那次）。缺省按 1 计（恢复即已执行一次）。
   */
  toolStepsUsed?: number | undefined;
  /**
   * Tool-recovery path only: max tool steps per turn. 传 1 时行为与
   * 旧版"一轮一次工具"逐字节一致（防腐回归锚点）。缺省按 1 计。
   */
  toolStepBudget?: number | undefined;
};

export type DecisionDispositionResult =
  | { action: "terminal" }
  | { action: "checkpoint"; toolPlan: ToolPlan };

/**
 * Commit the durable outcome for a parsed decision.
 * Returns `checkpoint` when the turn must pause for tool execution;
 * every other branch is terminal for the turn.
 */
export async function commitDecisionDisposition(
  input: DecisionDispositionInput,
): Promise<DecisionDispositionResult> {
  const { db, decision, turnId, conversationId } = input;

  // 闸门：模型自行要求人工介入（显式 handoff / 高风险 / requiresHuman）。
  const gate = validateDecision(decision);
  if (gate.action === "handoff") {
    const withBriefing = input.path === "fresh";
    await commitAgentTurnHandoff(db, {
      conversationId,
      turnId,
      reason: withBriefing
        ? gate.reasonCode
        : `policy_gate_after_tool: ${gate.reasonCode}`,
      ...(withBriefing
        ? {
            briefing: buildHandoffBriefing({
              sourceConversationRevision: input.conversationRevision ?? 0,
              handoffReason: `policy_gate: ${gate.reasonCode}`,
              ...(decision.handoffBriefing
                ? { modelBriefing: decision.handoffBriefing }
                : {}),
            }),
          }
        : {}),
    });
    return { action: "terminal" };
  }

  if (input.path === "fresh") {
    return commitFreshDisposition(input);
  }
  return commitToolRecoveryDisposition(input);
}

/** Fresh decision path tail. */
async function commitFreshDisposition(
  input: DecisionDispositionInput,
): Promise<DecisionDispositionResult> {
  const { db, decision, turnId, conversationId } = input;

  // 防止处理已被取代的旧消息（有意先于工具计划构建，见模块注释）。
  if (
    input.triggerMessageId &&
    (await hasNewerAgentTurn(db, {
      turnId,
      conversationId,
      triggerMessageId: input.triggerMessageId,
    }))
  ) {
    await commitAgentTurnSuperseded(db, {
      conversationId,
      turnId,
      reason: "newer_turn_exists",
    });
    return { action: "terminal" };
  }

  // 构建工具计划：retrieve_knowledge 或 call_tool；工具名不在平台
  // 工具目录中时视为校验失败，直接失败（不发送、不重试循环）。
  // 与既有行为一致：仅 call_tool 分支捕获校验异常；
  // retrieve_knowledge 的参数异常向上抛出，由外层按可重试错误处理。
  let toolPlan: ToolPlan | null = null;
  if (decision.nextAction === "retrieve_knowledge") {
    toolPlan = knowledgeToolPlan(turnId, decision.knowledgeQuery ?? "");
  } else if (decision.nextAction === "call_tool" && decision.tool) {
    try {
      toolPlan = getToolPlan(decision, turnId);
    } catch {
      await commitAgentTurnFailure(db, {
        conversationId,
        turnId,
        errorCode: "invalid_tool_plan",
        events: [
          {
            eventType: "validation_failed",
            reasonCode: "invalid_tool_plan",
          },
        ],
      });
      return { action: "terminal" };
    }
  }

  // no_action：模型判断当前无需任何操作，静默处理（记录原因）
  if (decision.nextAction === "no_action") {
    await commitNoAction(db, conversationId, turnId, decision);
    return { action: "terminal" };
  }

  // wait（Phase 3）：模型要求等待客户回复 → 落会话唤醒计划。
  // wakeAt 到点由 wake dispatcher 续轮；带 nudge_text 的唤醒由代码
  // 经 createAgentReply 直发预承诺话术（不开模型）。静默落库语义
  // 保留（waiting_for_user），唤醒失败不阻断回合收尾。
  if (decision.nextAction === "wait") {
    await commitAgentTurnNoAction(db, {
      conversationId,
      turnId,
      reason: "waiting_for_user",
    });
    const now = new Date();
    await scheduleSessionWake(db, {
      conversationId,
      turnId,
      waitMs: decision.waitMs ?? 300_000,
      ...(decision.nudgeText ? { nudgeText: decision.nudgeText } : {}),
      now,
    });
    await ensureSessionOnWait(db, {
      conversationId,
      turnId,
      now,
    });
    return { action: "terminal" };
  }

  const invalidSegments = await commitReplyValidationFailure(
    db,
    conversationId,
    turnId,
    decision,
  );
  if (invalidSegments) return { action: "terminal" };

  if (toolPlan) {
    await persistAgentToolCheckpoint(db, {
      conversationId,
      turnId,
      toolPlan,
    });
    return { action: "checkpoint", toolPlan };
  }

  await commitAgentTurnOutcome(db, {
    conversationId,
    turnId,
    traceId: input.traceId,
    variant: "direct",
    responseText: decision.replyText,
    responseSegments: decision.replySegments,
    model: input.model,
    ...(input.aiEmployeeId ? { aiEmployeeId: input.aiEmployeeId } : {}),
    memoryWatermarkMessageId: memoryWatermarkMessageId(
      turnId,
      "fresh",
      decision.replySegments.length,
    ),
  });
  return { action: "terminal" };
}

/**
 * Tool-checkpoint recovery path tail: bounded tool loop.
 *
 * Phase 2 起"一轮一次工具"改为步数预算：恢复路径再决策出工具动作时，
 * 已执行步数（toolStepsUsed）未达预算（toolStepBudget）则允许继续
 * 规划下一次工具调用（checkpoint 续跑）；预算耗尽落 tool_chain_limit
 * 失败转人工。预算缺省 1 = 与旧版行为逐字节一致（防腐回归锚点）。
 */
async function commitToolRecoveryDisposition(
  input: DecisionDispositionInput,
): Promise<DecisionDispositionResult> {
  const { db, decision, turnId, conversationId } = input;

  // 防止工具链过长：步数预算（默认 1，turn-runner 按执行历史计算传入）
  const stepsUsed = input.toolStepsUsed ?? 1;
  const budget = input.toolStepBudget ?? 1;
  if (
    (decision.nextAction === "call_tool" ||
      decision.nextAction === "retrieve_knowledge") &&
    stepsUsed >= budget
  ) {
    await commitAgentTurnFailure(db, {
      conversationId,
      turnId,
      errorCode: "tool_chain_limit",
      handoffReason: "tool_chain_limit: reached maximum steps for one turn",
    });
    return { action: "terminal" };
  }

  if (decision.nextAction === "no_action") {
    await commitNoAction(db, conversationId, turnId, decision);
    return { action: "terminal" };
  }

  // 预算未耗尽时允许再次规划工具（有界 ReAct 续跑）：构建工具计划并
  // 落 checkpoint，turn-runner 执行后再次进入恢复路径。
  if (
    decision.nextAction === "retrieve_knowledge" ||
    decision.nextAction === "call_tool"
  ) {
    let toolPlan: ToolPlan;
    if (decision.nextAction === "retrieve_knowledge") {
      toolPlan = knowledgeToolPlan(turnId, decision.knowledgeQuery ?? "");
    } else {
      const plan = getToolPlan(decision, turnId);
      if (!plan) {
        await commitAgentTurnFailure(db, {
          conversationId,
          turnId,
          errorCode: "invalid_tool_plan",
          events: [
            {
              eventType: "validation_failed",
              reasonCode: "invalid_tool_plan",
            },
          ],
        });
        return { action: "terminal" };
      }
      toolPlan = plan;
    }
    await persistAgentToolCheckpoint(db, {
      conversationId,
      turnId,
      toolPlan,
    });
    return { action: "checkpoint", toolPlan };
  }

  const invalidSegments = await commitReplyValidationFailure(
    db,
    conversationId,
    turnId,
    decision,
  );
  if (invalidSegments) return { action: "terminal" };

  await commitAgentTurnOutcome(db, {
    conversationId,
    turnId,
    traceId: input.traceId,
    variant: "tool_result",
    responseText: decision.replyText,
    responseSegments: decision.replySegments,
    model: input.model,
    ...(input.aiEmployeeId ? { aiEmployeeId: input.aiEmployeeId } : {}),
    memoryWatermarkMessageId: memoryWatermarkMessageId(
      turnId,
      "tool_recovery",
      decision.replySegments.length,
    ),
  });
  return { action: "terminal" };
}

async function commitNoAction(
  db: Database,
  conversationId: string,
  turnId: string,
  decision: AgentDecision,
): Promise<void> {
  await commitAgentTurnNoAction(db, {
    conversationId,
    turnId,
    reason: decision.noActionReason ?? "no_action",
  });
}

/** 校验回复分段；不合法时落失败并返回 true（调用方终止处理）。 */
async function commitReplyValidationFailure(
  db: Database,
  conversationId: string,
  turnId: string,
  decision: AgentDecision,
): Promise<boolean> {
  if (decision.replySegments.length === 0) return false;
  try {
    validateReplySegments(decision.replySegments);
  } catch (error) {
    const reasonCode =
      error instanceof Error ? error.message : "reply_validation_failed";
    await commitAgentTurnFailure(db, {
      conversationId,
      turnId,
      errorCode: "reply_validation_failed",
      events: [{ eventType: "validation_failed", reasonCode }],
    });
    return true;
  }
  return false;
}

/**
 * 记忆水位线消息 ID：按路径派生，保持与既有落库值逐字节一致。
 * fresh: agent-message:{turnId}:{segmentCount}
 * tool_recovery: agent-message:{turnId}:tool-result:{segmentCount}
 */
export function memoryWatermarkMessageId(
  turnId: string,
  path: DecisionPath,
  segmentCount: number,
): string {
  return path === "fresh"
    ? `agent-message:${turnId}:${String(segmentCount)}`
    : `agent-message:${turnId}:tool-result:${String(segmentCount)}`;
}

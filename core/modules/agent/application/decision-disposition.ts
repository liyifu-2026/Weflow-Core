/**
 * Decision disposition: shared post-processing for LLM decisions.
 *
 * 改动归属登记（两批共享此单点，先声明再动刀）：
 * - 私聊批：吸收式回合（superseded → absorbed_into）、facts_card 落库
 * - 群聊批：chatType 禁续步闸、决策/回复/续步预算透传、工具步附带
 *   过程短讯（noteSegments）、end_session 收线（closeGroupThreadSessions）
 *
 * Both Agent Turn execution paths — the fresh decision path
 * (processAgentTurn) and the tool-checkpoint recovery path
 * (processPlannedToolTurn) — commit through this single module so the
 * two paths cannot drift. The former twin tails (fresh L237-483 vs
 * recovery L531-747, 2026-09 已合并) differed only in:
 * - 吸收策略（absorbVerdictFor，见下——差异承重且显式化）
 * - 工具步预算闸门（仅恢复路径；在吸收检查之前）
 * - 工具计划构建位置（fresh 在分支判定前预构建，恢复在分支内构建）
 * - outcome variant（fresh="direct"，tool_recovery="tool_result"）
 *
 * Deliberate normalisations (documented, covered by tests):
 * - Fresh path: the absorb check runs BEFORE tool-plan construction.
 *   An absorbed turn no longer burns tool-plan validation or risks an
 *   invalid_tool_plan failure/handoff for a turn that must die anyway.
 * - The former `agent_recommended` handoff blocks after the gate were
 *   unreachable (validateDecision returns handoff for exactly
 *   requiresHuman || riskLevel === "high" || nextAction === "handoff",
 *   and the gate commits before those blocks could run). They are
 *   removed, not ported.
 * - 恢复路径此前缺少 wait/end_session 分支：wait 落成空回复 outcome、
 *   end_session 不关会话（提示词却宣称支持）——2026-09-09 修复，两路径
 *   共享同一分支。
 * - 工具动作附带的 note segments 统一为软闸（prepareToolNoteSegments）；
 *   曾存在 fresh 走硬校验（回复校验失败即终态）、恢复走软闸的不对称，
 *   按该能力的文档契约（「装饰性能力绝不弄坏功能性路径」）统一为软闸。
 *
 * This module commits outcomes; it never calls the model or tools.
 */
import { and, eq, sql } from "drizzle-orm";
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
  commitAgentTurnReplyStep,
  commitAgentTurnSuperseded,
  completeAgentTurnAfterSteps,
  countStepBatches,
  persistAgentToolCheckpoint,
} from "./agent-turn-outcome-command.js";
import { DEFAULT_BEHAVIOR_SETTINGS } from "./behavior-settings.js";
import { isDuplicateOfLastReply } from "./duplicate-reply.js";
import {
  isEmptyFactCard,
  sanitizeFactCard,
  upsertConversationFacts,
} from "./conversation-facts.js";
import { findNewerActiveTurnIds } from "./turn-utils.js";
import {
  ensureSessionOnWait,
  scheduleSessionWake,
} from "./session-wake.js";
import {
  closeAgentSession,
  closeGroupThreadSessions,
} from "./agent-session.js";
import { recordAgentTurnEvent } from "./agent-turn-events.js";
import {
  commitScheduledSend,
  countPendingScheduledSends,
  countScheduledSendsCreatedSince,
  shiftOutOfQuietHours,
} from "./scheduled-sends.js";

type Database = NodePgDatabase<typeof schema>;

/** Which execution path produced the decision. */
export type DecisionPath = "fresh" | "tool_recovery";

/**
 * 吸收裁决：插话命中（存在更新的活跃轮次）时，当前决策的分流。
 * - discard         过时的生命周期决策作废不落库，回合继续，下一次
 *                   决策在含插话的新鲜上下文上进行；
 * - commit-as-step  先把回复以 step 落库再继续（仅恢复路径的 reply/ask）；
 * - carry-through   查证/定时/收线意图对新上下文仍有效，照常走分支。
 *
 * 差异是承重的，不是漂移：工具结果只存在于恢复决策的提示词里
 * （fcToolMessages 现场合成，buildAgentContext 不含工具结果）——恢复路径
 * 若照 fresh 语义丢弃 reply，工具结论就永久丢失，下一次 fresh 决策两手
 * 空空（可能重烧工具预算或无证据作答）。反过来 fresh 的旧回复可由含
 * 插话的新决策完全再生，丢弃零损失。此矩阵由测试逐格钉住。
 */
export type AbsorbVerdict = "discard" | "commit-as-step" | "carry-through";

export function absorbVerdictFor(
  path: DecisionPath,
  decision: AgentDecision,
): AbsorbVerdict {
  const lifecycle =
    decision.nextAction === "reply" ||
    decision.nextAction === "ask_for_information" ||
    decision.nextAction === "no_action" ||
    decision.nextAction === "wait";
  if (!lifecycle) return "carry-through";
  const carriesToolConclusion =
    path === "tool_recovery" &&
    (decision.nextAction === "reply" ||
      decision.nextAction === "ask_for_information") &&
    decision.replySegments.length > 0;
  return carriesToolConclusion ? "commit-as-step" : "discard";
}

export type DecisionDispositionInput = {
  db: Database;
  decision: AgentDecision;
  turnId: string;
  conversationId: string;
  traceId: string;
  path: DecisionPath;
  /**
   * 触发消息 ID：fresh 路径必传（吸收式回合的比较基准）；tool_recovery
   * 传入后同样启用吸收检查（修复恢复决策对插话视而不见的暗洞）。
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
   * Tool-recovery path only: 本 turn 已发生的工具尝试数（含失败尝试，
   * turn-runner 按工具执行记录计算传入）。缺省按 1 计（恢复即已尝试一次）。
   */
  toolStepsUsed?: number | undefined;
  /**
   * Tool-recovery path only: max tool steps per turn. 传 1 时行为与
   * 旧版"一轮一次工具"逐字节一致（防腐回归锚点）。缺省按 1 计
   * （生产路径由 turn-runner 传 DEFAULT_BEHAVIOR_SETTINGS.toolStepBudget）。
   */
  toolStepBudget?: number | undefined;
  /**
   * wait 决策缺省等待毫秒（R2 行为参数）；模型未给 wait_ms 时使用。
   * 缺省 300_000 = 与可配置前行为逐字节一致。
   */
  defaultWaitMs?: number | undefined;
  /**
   * wait 唤醒的预承诺 nudge 话术（R2 行为参数）；模型自带 nudge_text
   * 优先，仅当模型未给且配置了话术时代发。缺省不代发。
   */
  defaultNudgeText?: string | undefined;
  /**
   * 真 ReAct 循环开关（triage 直答档置 false）：false 时 reply/ask 一律
   * 照旧落 outcome 终态，不进入续步循环——简单消息没有"还没干完"，
   * 也不该在续步中升级回主力量模型。缺省 true（主力档可续）。
   */
  allowReplyContinuation?: boolean | undefined;
  /**
   * 会话类型（ADR-0010 Channel 事实）：群聊一律不进入续步循环——群聊回复
   * 必须一次说完，「继续干活」的循环语义只属于私聊排障场景
   * （2026-09-07 群聊三连发实测）。两条路径（fresh/tool_recovery）都由
   * turn-runner 从 conversations.chat_type 透传，不再由 ID 推断。
   */
  chatType: "private" | "group";
  /**
   * 会话片段 TTL 分钟数（R2 行为参数）；仅影响新建会话行。
   * 缺省 DEFAULT_SESSION_TTL_MS = 与可配置前行为逐字节一致。
   */
  defaultSessionTtlMinutes?: number | undefined;
  /**
   * 会话轮数上限（R2 行为参数）；仅影响新建会话行。
   * 缺省 MAX_ROUNDS_PER_SESSION = 与可配置前行为逐字节一致。
   */
  defaultSessionRoundBudget?: number | undefined;
  /**
   * 真 ReAct 循环预算（R3）：单 turn 最大决策步数（按 model_call 事件计数，
   * fresh 与 tool_recovery 两路径都记）。缺省 8 = DEFAULT_BEHAVIOR_SETTINGS。
   */
  decisionStepBudget?: number | undefined;
  /**
   * 真 ReAct 循环预算（R3）：单 turn 最大续步回复批数（reply 不带 wait_ms
   * 的中间说话）。缺省 2 = DEFAULT_BEHAVIOR_SETTINGS；超出后照常发出但收口。
   */
  replyStepBudget?: number | undefined;
  /**
   * 定时发送（SCHEDULED-SEND-PLAN）：联系人级开关与护栏。
   * enabled=false 时模型提示词不提供 schedule_send；此处兜底压制
   * （模型越权输出时静默降级，不失败、不转人工）。缺省 = 关闭。
   */
  scheduledSend?:
    | {
        enabled: boolean;
        maxPending: number;
        maxPerDay: number;
        quietStartHour: number;
        quietEndHour: number;
      }
    | undefined;
};

export type DecisionDispositionResult =
  | { action: "terminal" }
  | { action: "checkpoint"; toolPlan: ToolPlan }
  /**
   * 真 ReAct 续步：reply/ask 不带 wait_ms 且预算未耗尽 → 续步回复已落库、
   * turn 保持 running，由 executor 继续驱动下一步决策。
   */
  | { action: "continue" };

/**
 * Commit the durable outcome for a parsed decision.
 * Returns `checkpoint` when the turn must pause for tool execution;
 * every other branch is terminal for the turn.
 */
export async function commitDecisionDisposition(
  input: DecisionDispositionInput,
): Promise<DecisionDispositionResult> {
  const { db, decision, turnId, conversationId } = input;

  // 会话事实卡更新（私聊批）：咨询性数据，失败静默——绝不因卡片落库
  // 阻断任何决策分支（包括 handoff/终态）。
  if (decision.factsCard && typeof decision.factsCard === "object") {
    try {
      const card = sanitizeFactCard(decision.factsCard);
      if (!isEmptyFactCard(card)) {
        await upsertConversationFacts(db, { conversationId, card });
      }
    } catch {
      // 事实卡落库失败不影响回合
    }
  }

  // 闸门：模型自行要求人工介入（显式 handoff / 高风险 / requiresHuman）。
  const gate = validateDecision(decision);
  if (gate.action === "handoff") {
    const withBriefing = input.path === "fresh";
    // 告别语只在模型显式选择 handoff 时携带：requiresHuman/high-risk 触发
    // 闸门时的 reply/ask 文本不是告别语，可能是被拦下的内容，不得代发。
    const farewellSegments =
      decision.nextAction === "handoff"
        ? decision.replySegments
            .map((segment) => segment.trim())
            .filter((segment) => segment.length > 0)
        : [];
    await commitAgentTurnHandoff(db, {
      conversationId,
      turnId,
      reason: withBriefing
        ? gate.reasonCode
        : `policy_gate_after_tool: ${gate.reasonCode}`,
      ...(farewellSegments.length > 0 ? { farewellSegments } : {}),
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

/** Fresh path preamble: absorb check → tool-plan construction → shared tail. */
async function commitFreshDisposition(
  input: DecisionDispositionInput,
): Promise<DecisionDispositionResult> {
  // 吸收式回合（私聊批）：回合运行中客户补充了消息 → 不再"处决自己
  // 让新轮从头重启"，而是把排队中的新轮标记为 absorbed，本次决策按
  // absorbVerdictFor 矩阵分流（见其文档）。插话 turn 行保留为持久化
  // 保证；若吸收标记失败，最坏退化为旧打断-重启行为。
  const absorbed = await absorbQueuedInterjections(input);
  if (absorbed) return absorbed;

  // 构建工具计划：retrieve_knowledge 或 call_tool；工具名不在平台
  // 工具目录中时视为校验失败，直接失败（不发送、不重试循环）。
  // 与既有行为一致：仅 call_tool 分支捕获校验异常；
  // retrieve_knowledge 的参数异常向上抛出，由外层按可重试错误处理。
  // （在吸收检查之后构建——已被吸收的过时决策不烧工具计划校验。）
  const { db, decision, turnId } = input;
  let toolPlan: ToolPlan | null = null;
  if (decision.nextAction === "retrieve_knowledge") {
    toolPlan = knowledgeToolPlan(turnId, decision.knowledgeQuery ?? "");
  } else if (decision.nextAction === "call_tool" && decision.tool) {
    try {
      toolPlan = getToolPlan(decision, turnId);
    } catch {
      await commitAgentTurnFailure(db, {
        conversationId: input.conversationId,
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

  return commitDispositionTail(input, { kind: "fresh", toolPlan });
}

/** Tool-recovery path preamble: step-budget gate → absorb check → shared tail. */
async function commitToolRecoveryDisposition(
  input: DecisionDispositionInput,
): Promise<DecisionDispositionResult> {
  const { db, decision, turnId, conversationId } = input;

  // 防止工具链过长：步数预算（出厂默认 4；含失败尝试，turn-runner 传入）。
  // 预算耗尽的工具决策直接失败转人工，先于吸收检查（既有顺序）。
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

  // 吸收式回合（恢复路径）：恢复决策按 absorbVerdictFor 矩阵分流——
  // 携带工具结论的 reply/ask 以 step 落库（结论不可再生），其余过时
  // 生命周期决策作废，查证/定时/收线照常走分支。
  const absorbed = await absorbQueuedInterjections(input);
  if (absorbed) return absorbed;

  return commitDispositionTail(input, { kind: "tool_recovery" });
}

/**
 * 双路径共享的处置尾迹：no_action / schedule_send / wait / end_session /
 * 回复校验 / 重复收口 / 工具检查点 / 续步 / 终态落库。两路径此前各写一份
 * （曾漂移出恢复路径缺 wait/end_session、工具短讯硬软闸不对称），现单点。
 */
async function commitDispositionTail(
  input: DecisionDispositionInput,
  mode: { kind: "fresh"; toolPlan: ToolPlan | null } | { kind: "tool_recovery" },
): Promise<DecisionDispositionResult> {
  const { db, decision, turnId, conversationId } = input;
  const fresh = mode.kind === "fresh";
  const outcomeVariant = fresh ? "direct" : "tool_result";
  const commitReplyOutcome = async (segments: string[]): Promise<void> => {
    await commitAgentTurnOutcome(db, {
      conversationId,
      turnId,
      traceId: input.traceId,
      variant: outcomeVariant,
      responseText: decision.replyText,
      responseSegments: segments,
      model: input.model,
      ...(input.aiEmployeeId ? { aiEmployeeId: input.aiEmployeeId } : {}),
    });
  };

  // no_action：模型判断当前无需任何操作，静默处理（记录原因）
  if (decision.nextAction === "no_action") {
    await commitNoAction(db, conversationId, turnId, decision);
    return { action: "terminal" };
  }

  // 定时发送（SCHEDULED-SEND-PLAN）：模型约定未来某时刻直发一段既定文本。
  if (
    decision.nextAction === "schedule_send" &&
    (await commitScheduleSendDisposition(input))
  ) {
    return { action: "terminal" };
  }

  // wait（Phase 3）：模型要求等待客户回复 → 落会话唤醒计划。
  // wakeAt 到点由 wake dispatcher 续轮；带 nudge_text 的唤醒由代码
  // 经 createAgentReply 直发预承诺话术（不开模型）。静默落库语义
  // 保留（waiting_for_user），唤醒失败不阻断回合收尾。
  // （恢复路径曾缺此分支——wait 落成空回复 outcome，已修复。）
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
      waitMs: decision.waitMs ?? input.defaultWaitMs ?? 300_000,
      ...(decision.nudgeText
        ? { nudgeText: decision.nudgeText }
        : input.defaultNudgeText
          ? { nudgeText: input.defaultNudgeText }
          : {}),
      now,
    });
    await ensureSessionOnWait(db, {
      conversationId,
      turnId,
      now,
      ...(input.defaultSessionTtlMinutes !== undefined
        ? { ttlMs: input.defaultSessionTtlMinutes * 60_000 }
        : {}),
      ...(input.defaultSessionRoundBudget !== undefined
        ? { roundBudget: input.defaultSessionRoundBudget }
        : {}),
    });
    return { action: "terminal" };
  }

  // end_session（Phase 3 接线）：模型判断会话片段可以收尾 → 关闭
  // agent_sessions 状态行。可选携带收尾话术（reply_segments）：先照常
  // 走回复校验与落库发送，再关闭；没有话术则按 no_action(session_closed)
  // 静默收尾。end_session 幂等：没有 open 片段时空操作。
  // （恢复路径曾缺此分支——end_session 不关会话，已修复。）
  if (decision.nextAction === "end_session") {
    const farewellSegments = decision.replySegments.filter(
      (segment) => segment.trim().length > 0,
    );
    if (farewellSegments.length > 0) {
      const invalidSegments = await commitReplyValidationFailure(
        db,
        conversationId,
        turnId,
        decision,
      );
      if (invalidSegments) return { action: "terminal" };
      await commitReplyOutcome(farewellSegments);
    } else {
      await commitAgentTurnNoAction(db, {
        conversationId,
        turnId,
        reason: "session_closed",
      });
    }
    await closeAgentSession(db, {
      conversationId,
      closureSummary: decision.closureSummary ?? "",
      now: new Date(),
    });
    // 群聊对话线程：模型自主收线（end_session = 关线程，回到仅 @ 状态）
    if (input.chatType === "group") {
      await closeGroupThreadSessions(db, {
        conversationId,
        now: new Date(),
      });
    }
    return { action: "terminal" };
  }

  // 回复/追问：分段校验（硬闸，校验失败即终态）。工具动作不在此校验——
  // 其附带短讯由 prepareToolNoteSegments 软闸处理（曾存在 fresh 硬校验/
  // 恢复软闸的不对称，按「装饰性能力绝不弄坏功能性路径」统一为软闸）。
  if (
    decision.nextAction === "reply" ||
    decision.nextAction === "ask_for_information"
  ) {
    const invalidSegments = await commitReplyValidationFailure(
      db,
      conversationId,
      turnId,
      decision,
    );
    if (invalidSegments) return { action: "terminal" };
  }

  // 模型重复自己已发出的上一条回复 = 说完了：不再二发，以既有内容优雅收口
  //（续步循环里模型复读 step 内容、或跨轮次逐字重复都会命中；避免重复回复
  // 撞 duplicate_reply 压制把轮次落成 suppressed_policy）。
  if (await replyDuplicatesLastAgentMessage(db, input)) {
    await completeAgentTurnAfterSteps(db, {
      conversationId,
      turnId,
      responseText: decision.replyText,
      responseSegments: decision.replySegments,
      ...(input.model ? { model: input.model } : {}),
    });
    return { action: "terminal" };
  }

  // 工具检查点：fresh 预构建的计划在此落库；恢复路径在此构建
  //（预算闸门已在其前置段落通过）。
  if (
    decision.nextAction === "retrieve_knowledge" ||
    decision.nextAction === "call_tool"
  ) {
    let toolPlan: ToolPlan | null = null;
    if (mode.kind === "fresh") {
      toolPlan = mode.toolPlan;
    } else {
      // 与 fresh 路径同语义：目录外工具名（getToolPlan throw）或参数校验
      // 失败一律按 invalid_tool_plan 终态处理。此处曾无 try/catch——
      // 2026-09-07 幻觉工具名穿顶导致 turn 假死 5min 等回收（回归根因）。
      try {
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
    if (toolPlan) {
      await persistAgentToolCheckpoint(db, {
        conversationId,
        turnId,
        toolPlan,
        traceId: input.traceId,
        ...(input.aiEmployeeId ? { aiEmployeeId: input.aiEmployeeId } : {}),
        noteSegments: await prepareToolNoteSegments(db, {
          conversationId,
          turnId,
          decision,
        }),
      });
      return { action: "checkpoint", toolPlan };
    }
    // fresh 退化输入（call_tool 无 tool 参数 → 预构建为 null）：保持既有
    // 行为，不落检查点，落入下方续步/终态逻辑。
  }

  // 真 ReAct：reply/ask 不带 wait_ms = 本回合还没干完，预算内续步循环。
  if (await shouldContinueReplyStep(db, input)) {
    const step = await commitAgentTurnReplyStep(db, {
      conversationId,
      turnId,
      traceId: input.traceId,
      segments: decision.replySegments,
      model: input.model,
      ...(input.aiEmployeeId ? { aiEmployeeId: input.aiEmployeeId } : {}),
    });
    if (step.status === "persisted") return { action: "continue" };
    return { action: "terminal" };
  }

  await commitReplyOutcome(decision.replySegments);
  await scheduleWaitAfterReply(input);
  return { action: "terminal" };
}

/**
 * 吸收检查（两路径共享）：存在更新的活跃轮次时逐个标记 absorbed，
 * 按 absorbVerdictFor 矩阵处置当前决策。
 * 返回非 null = 已终局处置（continue/terminal）；null = carry-through，
 * 调用方继续走正常分支。
 */
async function absorbQueuedInterjections(
  input: DecisionDispositionInput,
): Promise<DecisionDispositionResult | null> {
  if (!input.triggerMessageId) return null;
  const { db, decision, turnId, conversationId } = input;
  const newerTurnIds = await findNewerActiveTurnIds(db, {
    turnId,
    conversationId,
    triggerMessageId: input.triggerMessageId,
  });
  if (newerTurnIds.length === 0) return null;
  for (const newerTurnId of newerTurnIds) {
    await commitAgentTurnSuperseded(db, {
      conversationId,
      turnId: newerTurnId,
      reason: `absorbed_into:${turnId}`,
    });
  }
  const verdict = absorbVerdictFor(input.path, decision);
  await recordAgentTurnEvent(db, {
    turnId,
    conversationId,
    eventType: "turn_absorbed_input",
    payload: {
      absorbedCount: newerTurnIds.length,
      verdict,
      action: decision.nextAction,
    },
  });
  if (verdict === "discard") return { action: "continue" };
  if (verdict === "commit-as-step") {
    const invalid = await commitReplyValidationFailure(
      db,
      conversationId,
      turnId,
      decision,
    );
    if (invalid) return { action: "terminal" };
    await commitAgentTurnReplyStep(db, {
      conversationId,
      turnId,
      traceId: input.traceId,
      segments: decision.replySegments,
      model: input.model,
      ...(input.aiEmployeeId ? { aiEmployeeId: input.aiEmployeeId } : {}),
    });
    return { action: "continue" };
  }
  return null;
}

/**
 * 「说话并等待」：reply/ask 携带 wait_ms 时，回复落库后挂会话唤醒
 * 计时器——到期对方仍未回复（新入站会作废唤醒）则唤醒续轮，模型面对
 * "对方未回复"上下文自行决定轻追问 / 继续等 / 收尾。未携带 wait_ms
 * 的回复保持旧语义：轮次终态，无计时器。
 */
async function scheduleWaitAfterReply(input: DecisionDispositionInput) {
  const { db, decision, turnId, conversationId } = input;
  if (
    decision.nextAction !== "reply" &&
    decision.nextAction !== "ask_for_information"
  ) {
    return;
  }
  if (!decision.waitMs) return;
  const now = new Date();
  await scheduleSessionWake(db, {
    conversationId,
    turnId,
    waitMs: decision.waitMs,
    ...(decision.nudgeText ? { nudgeText: decision.nudgeText } : {}),
    now,
  });
  await ensureSessionOnWait(db, {
    conversationId,
    turnId,
    now,
    ...(input.defaultSessionTtlMinutes !== undefined
      ? { ttlMs: input.defaultSessionTtlMinutes * 60_000 }
      : {}),
    ...(input.defaultSessionRoundBudget !== undefined
      ? { roundBudget: input.defaultSessionRoundBudget }
      : {}),
  });
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

/**
 * 定时发送（SCHEDULED-SEND-PLAN）：模型约定未来某时刻直发一段既定文本。
 * 护栏全部代码持有（联系人开关 / pending 上限 / 每日上限），模型越权时
 * 静默降级——定时不发，但不失败、不转人工；即时确认回复（若给出）照常
 * 走回复校验与落库，没有确认回复按 no_action(scheduled_send) 收尾。
 * 返回 true 表示本分支已终态处理该轮次。
 */
async function commitScheduleSendDisposition(
  input: DecisionDispositionInput,
): Promise<boolean> {
  const { db, decision, turnId, conversationId } = input;
  const guardrails = input.scheduledSend;
  const content = decision.scheduledMessage;
  const sendAt = decision.scheduledSendAt;
  if (
    guardrails?.enabled === true &&
    content !== undefined &&
    sendAt !== undefined
  ) {
    const pending = await countPendingScheduledSends(db, conversationId);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayTotal = await countScheduledSendsCreatedSince(
      db,
      conversationId,
      startOfDay,
    );
    if (
      pending >= guardrails.maxPending ||
      todayTotal >= guardrails.maxPerDay
    ) {
      await recordAgentTurnEvent(db, {
        turnId,
        conversationId,
        eventType: "scheduled_send_cancelled",
        reasonCode:
          pending >= guardrails.maxPending ? "pending_limit" : "daily_limit",
        payload: {},
      });
    } else {
      const shifted = shiftOutOfQuietHours(
        sendAt,
        guardrails.quietStartHour,
        guardrails.quietEndHour,
      );
      await commitScheduledSend(db, {
        conversationId,
        turnId,
        content,
        sendAt: shifted,
      });
      await recordAgentTurnEvent(db, {
        turnId,
        conversationId,
        eventType: "scheduled_send_created",
        payload: { sendAt: shifted.toISOString() },
      });
    }
  } else {
    await recordAgentTurnEvent(db, {
      turnId,
      conversationId,
      eventType: "scheduled_send_cancelled",
      reasonCode:
        guardrails?.enabled === true
          ? "invalid_request"
          : "scheduled_send_disabled",
      payload: {},
    });
  }
  if (decision.replySegments.length > 0 && decision.replySegments[0] !== "") {
    const invalid = await commitReplyValidationFailure(
      db,
      conversationId,
      turnId,
      decision,
    );
    if (invalid) return true;
    await commitAgentTurnOutcome(db, {
      conversationId,
      turnId,
      traceId: input.traceId,
      variant: input.path === "fresh" ? "direct" : "tool_result",
      responseText: decision.replyText,
      responseSegments: decision.replySegments,
      model: input.model,
      ...(input.aiEmployeeId ? { aiEmployeeId: input.aiEmployeeId } : {}),
    });
  } else {
    await commitAgentTurnNoAction(db, {
      conversationId,
      turnId,
      reason: "scheduled_send",
    });
  }
  return true;
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
 * 重复回复判定（优雅收口前置）：reply/ask 的整批文本与上一条已发出的
 * Agent 回复逐字等价（normalize 后）= 模型在复读自己，不该再发第二条。
 */
async function replyDuplicatesLastAgentMessage(
  db: Database,
  input: DecisionDispositionInput,
): Promise<boolean> {
  const { decision, conversationId } = input;
  if (
    decision.nextAction !== "reply" &&
    decision.nextAction !== "ask_for_information"
  ) {
    return false;
  }
  if (decision.replyText.trim() === "") return false;
  return isDuplicateOfLastReply(db, conversationId, decision.replyText);
}

/**
 * 真 ReAct 续步判定：reply/ask 且不带 wait_ms（wait_ms = 说完交权），
 * 且两道预算未耗尽——决策步数（model_call 事件，两路径都记）与
 * 续步批数（step 变体消息批次）。预算代码持有，模型不可绕过。
 */
async function shouldContinueReplyStep(
  db: Database,
  input: DecisionDispositionInput,
): Promise<boolean> {
  const { decision, turnId } = input;
  if (input.allowReplyContinuation === false) return false;
  // 群聊硬闸：群聊回复一次说完，永不续步（chatType 为必填 Channel 事实）。
  if (input.chatType === "group") return false;
  if (
    decision.nextAction !== "reply" &&
    decision.nextAction !== "ask_for_information"
  ) {
    return false;
  }
  if (decision.waitMs) return false;
  const decisionBudget =
    input.decisionStepBudget ?? DEFAULT_BEHAVIOR_SETTINGS.decisionStepBudget;
  const stepBudget =
    input.replyStepBudget ?? DEFAULT_BEHAVIOR_SETTINGS.replyStepBudget;
  const decidedRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.agentTurnEvents)
    .where(
      and(
        eq(schema.agentTurnEvents.turnId, turnId),
        eq(schema.agentTurnEvents.eventType, "model_call"),
      ),
    );
  if ((decidedRows[0]?.count ?? 0) >= decisionBudget) return false;
  const stepBatches = await countStepBatches(db, turnId);
  return stepBatches < stepBudget;
}

/**
 * 工具动作附带的过程性短讯软闸（防滥用不伤主路径）：
 * 空数组直通；超 2 条或校验失败（>500 字/空段）→ 丢弃 + tool_note_suppressed
 * 事件，工具照常执行。装饰性能力绝不弄坏功能性路径。
 */
async function prepareToolNoteSegments(
  db: Database,
  input: {
    conversationId: string;
    turnId: string;
    decision: AgentDecision;
  },
): Promise<string[]> {
  const { decision, turnId, conversationId } = input;
  if (decision.replySegments.length === 0) return [];
  if (decision.replySegments.length > 2) {
    await recordAgentTurnEvent(db, {
      turnId,
      conversationId,
      eventType: "tool_note_suppressed",
      reasonCode: "too_many_segments",
      payload: { count: decision.replySegments.length },
    });
    return [];
  }
  try {
    return validateReplySegments(decision.replySegments);
  } catch (error) {
    await recordAgentTurnEvent(db, {
      turnId,
      conversationId,
      eventType: "tool_note_suppressed",
      reasonCode: error instanceof Error ? error.message : "tool_note_invalid",
      payload: {},
    });
    return [];
  }
}

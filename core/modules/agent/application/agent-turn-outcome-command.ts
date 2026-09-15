/**
 * Transactional Agent Turn outcome command.
 *
 * Model and Provider calls happen before this command. This command owns the
 * durable business outcome: Handoff, Message, AgentTurn, Memory scheduling and
 * turn events are committed together under the conversation ownership lock.
 *
 * The platform does not maintain Solution case state here; Solution state
 * lives in Solution-owned storage (via plugin backend routes), never in the
 * Agent Turn outcome transaction.
 */
import { eq, like, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { lockConversationOwnership } from "../../../infrastructure/postgres/ownership-lock.js";
import { conversationEvents } from "../../../infrastructure/events/conversation-events.js";
import { createHandoffInTransaction } from "../../handoff/application/handoff-service.js";
import {
  agentHandoffClientRequestId,
  humanizeHandoffSummary,
} from "./trigger-agent-handoff.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";
import { scheduleMemoryCaptureInTransaction } from "../../memory/application/schedule-memory-capture.js";
import {
  createAgentReply,
  type AgentReplyVariant,
} from "../../conversations/application/message-service.js";
import { AgentTurnService } from "./agent-turn-service.js";
import { isDuplicateOfLastReply } from "./duplicate-reply.js";
import { recordAgentTurnEvent } from "./agent-turn-events.js";
import { freezePendingScheduledSendsForHandoff } from "./scheduled-sends.js";
import type { ToolPlan } from "./tool-plan.js";

export type AgentTurnOutcomeInput = {
  conversationId: string;
  turnId: string;
  traceId: string;
  variant: AgentReplyVariant;
  responseText: string;
  responseSegments: string[];
  model?: string;
  /**
   * AI 员工标识（Solution 提供，平台不解释；如 AI 员工 definition id）。
   * 提供时写入 agent 出站消息的 actor_id，前端据此渲染该员工的专属头像。
   */
  aiEmployeeId?: string;
};

export type AgentTurnOutcomeResult =
  | { status: "committed"; replyBatchId: string | null }
  | { status: "auto_send_disabled" }
  | { status: "suppressed_policy"; reason: string }
  | { status: "suppressed_handoff"; reason: string }
  | { status: "superseded"; reason: string };

export type AgentToolCheckpointResult =
  | { status: "planned" }
  | { status: "suppressed_policy"; reason: string }
  | { status: "suppressed_handoff"; reason: string }
  | { status: "superseded"; reason: string };

type TransactionDatabase = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

export type AgentTurnHandoffInput = {
  conversationId: string;
  turnId: string;
  reason: string;
  briefing?: schema.HandoffBriefing;
  assignedQueueId?: string | null;
  /**
   * 模型显式选择 handoff 时自带的告别话术；作为转接前最后一条 agent
   * 消息落库发送。缺省 = 转人工不发送任何客户可见文案。
   */
  farewellSegments?: string[];
};

export type AgentTurnHandoffResult =
  | { status: "committed" }
  | { status: "superseded"; reason: string }
  | { status: "suppressed_handoff"; reason: string };

export type AgentTurnNoActionInput = {
  conversationId: string;
  turnId: string;
  reason: string;
};

/** Commits a policy/handoff suppression under the ownership lock. */
export async function commitAgentTurnSuppression(
  db: NodePgDatabase<typeof schema>,
  input: { conversationId: string; turnId: string; reason: string },
): Promise<void> {
  await db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    const [handoff] = await transaction
      .select({ agentPaused: schema.handoffStates.agentPaused })
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    if (handoff?.agentPaused) {
      await suppressHandoff(transaction, input.turnId, input.reason);
    } else {
      await suppressPolicy(transaction, input.turnId, input.reason);
    }
  });
}

/** Commits a superseded terminal result under the ownership lock. */
export async function commitAgentTurnSuperseded(
  db: NodePgDatabase<typeof schema>,
  input: { conversationId: string; turnId: string; reason: string },
): Promise<void> {
  await db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    await new AgentTurnService(transaction).supersede(
      input.turnId,
      input.reason,
    );
  });
}

/** Commits Handoff and AgentTurn terminal state atomically. */
export async function commitAgentTurnHandoff(
  db: NodePgDatabase<typeof schema>,
  input: AgentTurnHandoffInput,
): Promise<AgentTurnHandoffResult> {
  return db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);

    const handoff = await createAgentHandoffInTransaction(transaction, input);
    if (handoff === "already_active") {
      await suppressHandoff(transaction, input.turnId, "handoff_active");
      return { status: "suppressed_handoff", reason: "handoff_active" };
    }
    await new AgentTurnService(transaction).suppressHandoff(
      input.turnId,
      input.reason,
    );
    await recordAgentTurnEvent(transaction, {
      turnId: input.turnId,
      conversationId: input.conversationId,
      eventType: "handoff_created",
      reasonCode: input.reason,
    });
    // 定时发送冻结（SCHEDULED-SEND-PLAN 决策 #6）：人工接入即冻结全部
    // pending 定时消息进待审，由接手客服放行/改期/丢弃；不自动恢复。
    await freezePendingScheduledSendsForHandoff(
      transaction,
      input.conversationId,
    );
    return { status: "committed" };
  });
}

/** Commits a silent/no_action result atomically. */
export async function commitAgentTurnNoAction(
  db: NodePgDatabase<typeof schema>,
  input: AgentTurnNoActionInput,
): Promise<
  | { status: "suppressed_policy"; reason: string }
  | { status: "suppressed_handoff"; reason: string }
  | { status: "superseded"; reason: string }
> {
  return db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    const [profile] = await transaction
      .select({ agentEnabled: schema.contactProfiles.agentEnabled })
      .from(schema.conversations)
      .innerJoin(
        schema.contactProfiles,
        eq(schema.contactProfiles.contactId, schema.conversations.contactId),
      )
      .where(eq(schema.conversations.conversationId, input.conversationId))
      .limit(1);
    const [handoff] = await transaction
      .select({ agentPaused: schema.handoffStates.agentPaused })
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    if (handoff?.agentPaused) {
      await suppressHandoff(transaction, input.turnId, "handoff_active");
      return { status: "suppressed_handoff", reason: "handoff_active" };
    }
    if (!profile?.agentEnabled) {
      await suppressPolicy(transaction, input.turnId, "agent_disabled");
      return { status: "suppressed_policy", reason: "agent_disabled" };
    }
    await suppressPolicy(transaction, input.turnId, input.reason);
    return { status: "suppressed_policy", reason: input.reason };
  });
}

/** Reconciles a failed execution and creates at most one Handoff atomically. */
export async function commitAgentTurnFailure(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    turnId: string;
    errorCode: string;
    handoffReason?: string;
    /** 失败路径的结构化交接简报：把真实失败原因与客户最后消息带给人工。 */
    briefing?: schema.HandoffBriefing;
    events?: Array<{
      eventType: Parameters<typeof recordAgentTurnEvent>[1]["eventType"];
      reasonCode?: string;
      payload?: Record<string, unknown>;
    }>;
  },
): Promise<void> {
  await db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    for (const event of input.events ?? []) {
      await recordAgentTurnEvent(transaction, {
        turnId: input.turnId,
        conversationId: input.conversationId,
        eventType: event.eventType,
        reasonCode: event.reasonCode,
        payload: event.payload,
      });
    }
    if (input.handoffReason) {
      const handoff = await createAgentHandoffInTransaction(transaction, {
        conversationId: input.conversationId,
        turnId: input.turnId,
        reason: input.handoffReason,
        ...(input.briefing ? { briefing: input.briefing } : {}),
      });
      if (handoff === "created") {
        await recordAgentTurnEvent(transaction, {
          turnId: input.turnId,
          conversationId: input.conversationId,
          eventType: "handoff_created",
          reasonCode: input.errorCode,
        });
      }
    }
    await new AgentTurnService(transaction).fail(input.turnId, input.errorCode);
  });
}

export async function commitAgentTurnOutcome(
  db: NodePgDatabase<typeof schema>,
  input: AgentTurnOutcomeInput,
): Promise<AgentTurnOutcomeResult> {
  return db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    const profiles = await transaction
      .select({
        contactId: schema.contactProfiles.contactId,
        agentEnabled: schema.contactProfiles.agentEnabled,
      })
      .from(schema.conversations)
      .innerJoin(
        schema.contactProfiles,
        eq(schema.contactProfiles.contactId, schema.conversations.contactId),
      )
      .where(eq(schema.conversations.conversationId, input.conversationId))
      .limit(1);
    const handoffs = await transaction
      .select({ agentPaused: schema.handoffStates.agentPaused })
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);

    if (handoffs[0]?.agentPaused) {
      await suppressHandoff(transaction, input.turnId);
      return { status: "suppressed_handoff", reason: "handoff_active" };
    }
    if (!profiles[0]?.agentEnabled) {
      await suppressPolicy(transaction, input.turnId);
      return { status: "suppressed_policy", reason: "agent_disabled" };
    }

    if (
      await isDuplicateOfLastReply(
        transaction,
        input.conversationId,
        input.responseText,
      )
    ) {
      await suppressPolicy(transaction, input.turnId, "duplicate_reply");
      return { status: "suppressed_policy", reason: "duplicate_reply" };
    }

    const runtime = await readRuntimeSettings(transaction, undefined, {
      fresh: true,
    });
    if (!runtime.autoSendEnabled) {
      await createAgentHandoffInTransaction(transaction, {
        conversationId: input.conversationId,
        turnId: input.turnId,
        reason: "auto_send_disabled: AI send disabled by operator",
      });
      await recordAgentTurnEvent(transaction, {
        turnId: input.turnId,
        conversationId: input.conversationId,
        eventType: "handoff_created",
        reasonCode: "auto_send_disabled",
      });
      const completed = await new AgentTurnService(transaction).complete(
        input.turnId,
        completionInput(input, "auto_send_disabled"),
      );
      if (!completed.applied) throw new Error("agent_outcome_conflict");
      return { status: "auto_send_disabled" };
    }

    const reply = await createAgentReply(transaction, {
      conversationId: input.conversationId,
      turnId: input.turnId,
      traceId: input.traceId,
      segments: input.responseSegments,
      variant: input.variant,
      ...(input.aiEmployeeId ? { actorId: input.aiEmployeeId } : {}),
    });
    // Real-time：Agent 出站消息落库后即时向 Console SSE 推送 agent_message，
    // 前端收到后回拉 Transcript；不依赖 Channel Host 的回执，避免「发送后等几秒才出现」。
    // 仅在新创建时推送；幂等回放（已存在 batch）不再重复触发，否则会造成消息闪烁。
    if (reply.created) {
      const occurredAt = new Date().toISOString();
      for (const message of reply.messages) {
        conversationEvents.publish({
          type: "agent_message",
          conversationId: input.conversationId,
          messageId: message.messageId,
          occurredAt,
        });
      }
    }
    // 记忆水位线 = 本批最后一条**已落库**消息（按落库结果取，不再用
    // 「turnId + 段数」镜像推导——段数一旦与实际落库集合不一致（例如批内
    // 重复段被去重），推导出的 messageId 就不存在，外键会直接把整笔回复
    // 事务打回）。
    const watermarkMessageId = reply.messages.at(-1)?.messageId;
    if (watermarkMessageId) {
      await scheduleMemoryCaptureInTransaction(transaction, {
        conversationId: input.conversationId,
        contactId: profiles[0].contactId,
        watermarkMessageId,
      });
    }
    const completed = await new AgentTurnService(transaction).complete(
      input.turnId,
      completionInput(input, null),
    );
    if (!completed.applied) throw new Error("agent_outcome_conflict");
    await recordAgentTurnEvent(transaction, {
      turnId: input.turnId,
      conversationId: input.conversationId,
      eventType: "reply_persisted",
      payload: {
        replyBatchId: reply.messages[0]?.replyBatchId,
        segmentCount: reply.messages.length,
      },
    });
    return {
      status: "committed",
      replyBatchId: reply.messages[0]?.replyBatchId ?? null,
    };
  });
}

function completionInput(
  input: AgentTurnOutcomeInput,
  errorCode: string | null,
) {
  return {
    responseText: input.responseText,
    responseSegments: input.responseSegments,
    errorCode,
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}

/** Persist one tool plan and the AgentTurn transition atomically. */
export async function persistAgentToolCheckpoint(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    turnId: string;
    toolPlan: ToolPlan;
    /**
     * 工具执行前的过程性短讯（可选，已由调用方软闸校验）：
     * 在落检查点的同一事务内先落库发出，再执行工具。短讯自身落库失败
     * 不拦工具主路径——丢弃短讯 + tool_note_suppressed 事件，照常检查点。
     */
    noteSegments?: string[] | undefined;
    traceId?: string | undefined;
    aiEmployeeId?: string | undefined;
  },
): Promise<AgentToolCheckpointResult> {
  return db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    const [profile] = await transaction
      .select({ agentEnabled: schema.contactProfiles.agentEnabled })
      .from(schema.conversations)
      .innerJoin(
        schema.contactProfiles,
        eq(schema.contactProfiles.contactId, schema.conversations.contactId),
      )
      .where(eq(schema.conversations.conversationId, input.conversationId))
      .limit(1);
    const [handoff] = await transaction
      .select({ agentPaused: schema.handoffStates.agentPaused })
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    if (handoff?.agentPaused) {
      await suppressHandoff(transaction, input.turnId);
      return { status: "suppressed_handoff", reason: "handoff_active" };
    }
    if (!profile?.agentEnabled) {
      await suppressPolicy(transaction, input.turnId);
      return { status: "suppressed_policy", reason: "agent_disabled" };
    }
    // 过程性短讯（真 ReAct「说+做同发」）：先发出短讯再落检查点；
    // 任何失败只降级丢短讯，绝不阻断工具主路径。
    if (input.noteSegments && input.noteSegments.length > 0) {
      try {
        const note = await createAgentReply(transaction, {
          conversationId: input.conversationId,
          turnId: input.turnId,
          traceId: input.traceId ?? `turn:${input.turnId}`,
          segments: input.noteSegments,
          variant: "tool_note",
          ...(input.aiEmployeeId ? { actorId: input.aiEmployeeId } : {}),
        });
        if (note.created) {
          const occurredAt = new Date().toISOString();
          for (const message of note.messages) {
            conversationEvents.publish({
              type: "agent_message",
              conversationId: input.conversationId,
              messageId: message.messageId,
              occurredAt,
            });
          }
        }
        await recordAgentTurnEvent(transaction, {
          turnId: input.turnId,
          conversationId: input.conversationId,
          eventType: "tool_note_persisted",
          payload: { segmentCount: input.noteSegments.length },
        });
      } catch (error) {
        await recordAgentTurnEvent(transaction, {
          turnId: input.turnId,
          conversationId: input.conversationId,
          eventType: "tool_note_suppressed",
          reasonCode: "tool_note_persist_failed",
          payload: {
            message: error instanceof Error ? error.message.slice(0, 200) : "",
          },
        });
      }
    }
    // 幂等键拼步数：有界 ReAct 的第二步起查询不同但键相同，固定键会让
    // onConflictDoNothing 静默吞掉新计划（模型第二次查证拿到的永远是
    // 第一步的旧结果）。同一会话锁内串行，count+1 即当前步号；同一步
    // 重投时 count 不变，幂等保持。
    const existingSteps = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.toolExecutions)
      .where(eq(schema.toolExecutions.turnId, input.turnId));
    const stepKey = `${input.toolPlan.idempotencyKey}:${String(
      (existingSteps[0]?.count ?? 0) + 1,
    )}`;
    await transaction
      .insert(schema.toolExecutions)
      .values({
        executionId: stepKey,
        turnId: input.turnId,
        conversationId: input.conversationId,
        toolName: input.toolPlan.name,
        status: "planned",
        idempotencyKey: stepKey,
        arguments: input.toolPlan.arguments,
      })
      .onConflictDoNothing();
    await transaction
      .update(schema.agentTurns)
      .set({
        status: "tool_planned",
        responseText: null,
        responseSegments: null,
      })
      .where(eq(schema.agentTurns.turnId, input.turnId));
    await recordAgentTurnEvent(transaction, {
      turnId: input.turnId,
      conversationId: input.conversationId,
      eventType: "tool_checkpoint_persisted",
      payload: { toolName: input.toolPlan.name },
    });
    return { status: "planned" };
  });
}

export type AgentTurnReplyStepResult =
  | { status: "persisted"; stepIndex: number; replyBatchId: string }
  | { status: "suppressed_policy"; reason: string }
  | { status: "suppressed_handoff"; reason: string };

/**
 * 续步循环的优雅收口：模型重复自己已发出的 step 内容 = 说完了。
 * 不再插入消息（重复内容不该二发），以既有 step 内容把轮次标记 completed
 * ——保持「说过话的轮次以 completed 收场」的审计语义，而不是让重复回复
 * 撞 duplicate_reply 压制、把轮次落成 suppressed_policy。
 */
export async function completeAgentTurnAfterSteps(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    turnId: string;
    responseText: string;
    responseSegments: string[];
    model?: string;
  },
): Promise<void> {
  await db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    const [handoff] = await transaction
      .select({ agentPaused: schema.handoffStates.agentPaused })
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    if (handoff?.agentPaused) {
      await suppressHandoff(transaction, input.turnId);
      return;
    }
    const completed = await new AgentTurnService(transaction).complete(
      input.turnId,
      {
        responseText: input.responseText,
        responseSegments: input.responseSegments,
        errorCode: null,
        ...(input.model === undefined ? {} : { model: input.model }),
      },
    );
    if (!completed.applied) throw new Error("agent_outcome_conflict");
  });
}

/**
 * 回合内续步回复（真 ReAct：reply 不带 wait_ms = 本回合还没干完）。
 *
 * 与 commitAgentTurnOutcome 的本质差异：只落消息与事件，**不改 turn 状态**
 * （保持 running，由持有进程继续驱动下一步决策），也不做 auto_send 检查
 * （auto_send 关闭时出站 poller 会 hold 本批消息，最终回复的 outcome 路径
 * 负责创建 handoff——中途续步不重复触发）。同时刷新 startedAt，防止长循环
 * 被 5 分钟 STALE 回收在半路抢跑。步号（stepIndex）按既有 step 批数 +1 派生，
 * 同一会话锁内串行，崩溃重投时幂等 ID 不冲突。
 */
export async function commitAgentTurnReplyStep(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    turnId: string;
    traceId: string;
    segments: string[];
    model?: string;
    aiEmployeeId?: string;
  },
): Promise<AgentTurnReplyStepResult> {
  return db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    const [profile] = await transaction
      .select({
        contactId: schema.contactProfiles.contactId,
        agentEnabled: schema.contactProfiles.agentEnabled,
      })
      .from(schema.conversations)
      .innerJoin(
        schema.contactProfiles,
        eq(schema.contactProfiles.contactId, schema.conversations.contactId),
      )
      .where(eq(schema.conversations.conversationId, input.conversationId))
      .limit(1);
    const [handoff] = await transaction
      .select({ agentPaused: schema.handoffStates.agentPaused })
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    if (handoff?.agentPaused) {
      await suppressHandoff(transaction, input.turnId);
      return { status: "suppressed_handoff", reason: "handoff_active" };
    }
    if (!profile?.agentEnabled) {
      await suppressPolicy(transaction, input.turnId);
      return { status: "suppressed_policy", reason: "agent_disabled" };
    }
    const stepIndex = (await countStepBatches(transaction, input.turnId)) + 1;
    const reply = await createAgentReply(transaction, {
      conversationId: input.conversationId,
      turnId: input.turnId,
      traceId: input.traceId,
      segments: input.segments,
      variant: "step",
      stepIndex,
      ...(input.aiEmployeeId ? { actorId: input.aiEmployeeId } : {}),
    });
    if (reply.created) {
      const occurredAt = new Date().toISOString();
      for (const message of reply.messages) {
        conversationEvents.publish({
          type: "agent_message",
          conversationId: input.conversationId,
          messageId: message.messageId,
          occurredAt,
        });
      }
    }
    await scheduleMemoryCaptureInTransaction(transaction, {
      conversationId: input.conversationId,
      contactId: profile.contactId,
      watermarkMessageId:
        reply.messages[reply.messages.length - 1]?.messageId ??
        `agent-message:${input.turnId}:step:${String(stepIndex)}:${String(
          input.segments.length,
        )}`,
    });
    // 刷新活跃度：STALE 回收以 startedAt 为准，长循环必须每步续租。
    await transaction
      .update(schema.agentTurns)
      .set({ startedAt: new Date() })
      .where(eq(schema.agentTurns.turnId, input.turnId));
    await recordAgentTurnEvent(transaction, {
      turnId: input.turnId,
      conversationId: input.conversationId,
      eventType: "reply_step_persisted",
      payload: {
        stepIndex,
        segmentCount: input.segments.length,
        ...(input.model ? { model: input.model } : {}),
      },
    });
    return {
      status: "persisted",
      stepIndex,
      replyBatchId: reply.messages[0]?.replyBatchId ?? "",
    };
  });
}

/** 统计本 turn 已落库的续步回复批数（step 变体 replyBatchId 前缀计数）。 */
export async function countStepBatches(
  db: NodePgDatabase<typeof schema> | TransactionDatabase,
  turnId: string,
): Promise<number> {
  const rows = await db
    .select({
      count: sql<number>`count(distinct ${schema.messages.replyBatchId})::int`,
    })
    .from(schema.messages)
    .where(like(schema.messages.replyBatchId, `agent-reply:${turnId}:step:%`));
  return rows[0]?.count ?? 0;
}

async function suppressPolicy(
  db: TransactionDatabase,
  turnId: string,
  reason = "policy_suppressed",
) {
  const result = await new AgentTurnService(db).suppressPolicy(turnId, reason);
  if (!result.applied && result.currentStatus !== "suppressed_policy") {
    throw new Error("agent_outcome_conflict");
  }
}

async function suppressHandoff(
  db: TransactionDatabase,
  turnId: string,
  reason = "handoff_active",
) {
  const result = await new AgentTurnService(db).suppressHandoff(turnId, reason);
  if (!result.applied && result.currentStatus !== "suppressed_handoff") {
    throw new Error("agent_outcome_conflict");
  }
}

async function createAgentHandoffInTransaction(
  transaction: TransactionDatabase,
  input: AgentTurnHandoffInput,
): Promise<"created" | "already_active"> {
  const result = await createHandoffInTransaction(transaction, {
    conversationId: input.conversationId,
    actorUserId: "system-agent",
    clientRequestId: agentHandoffClientRequestId(input.turnId),
    summary: humanizeHandoffSummary(input.reason).slice(0, 1_000),
    sourceIp: "core",
    agentTurnId: input.turnId,
    assignedQueueId: input.assignedQueueId ?? null,
    ...(input.briefing ? { briefing: input.briefing } : {}),
    ...(input.farewellSegments
      ? { farewellSegments: input.farewellSegments }
      : {}),
  });
  if (result.status === "ok")
    return result.replayed ? "already_active" : "created";
  if (result.status === "invalid_transition") return "already_active";
  throw new Error(`agent handoff failed: ${result.status}`);
}

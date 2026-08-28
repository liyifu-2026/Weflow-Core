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
import { eq } from "drizzle-orm";
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
  memoryWatermarkMessageId: string;
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
    await scheduleMemoryCaptureInTransaction(transaction, {
      conversationId: input.conversationId,
      contactId: profiles[0].contactId,
      watermarkMessageId: input.memoryWatermarkMessageId,
    });
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
      await suppressPolicy(transaction, input.turnId, "agent_disabled");
      return { status: "suppressed_policy", reason: "agent_disabled" };
    }
    await transaction
      .insert(schema.toolExecutions)
      .values({
        executionId: input.toolPlan.idempotencyKey,
        turnId: input.turnId,
        conversationId: input.conversationId,
        toolName: input.toolPlan.name,
        status: "planned",
        idempotencyKey: input.toolPlan.idempotencyKey,
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
  });
  if (result.status === "ok")
    return result.replayed ? "already_active" : "created";
  if (result.status === "invalid_transition") return "already_active";
  throw new Error(`agent handoff failed: ${result.status}`);
}

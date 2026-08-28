/**
 * 人工接管服务模块
 * 管理会话的人工接管生命周期：创建、认领、接管、转交、释放和解决。
 * 每次状态转换支持幂等性校验，创建接管时自动暂停 Agent 并发送确认消息。
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { lockConversationOwnership } from "../../../infrastructure/postgres/ownership-lock.js";
import { AgentTurnService } from "../../agent/application/agent-turn-service.js";
import {
  enqueueHandoffTransferNotification,
  enqueuePendingHandoffNotifications,
} from "../../notifications/application/notification-outbox.js";

type TransitionType =
  "created" | "accepted" | "manual_taken_over" | "released" | "resolved";

/** 人工接管操作的统一返回结果类型 */
export type HandoffResult =
  | {
      status: "ok";
      replayed: boolean;
      handoff: typeof schema.handoffStates.$inferSelect;
    }
  | { status: "conversation_not_found" }
  | { status: "invalid_transition" }
  | { status: "not_assignee" }
  | { status: "assignee_not_found" }
  | {
      status: "already_claimed";
      handoff: typeof schema.handoffStates.$inferSelect;
      assignee: { userId: string; username: string } | undefined;
    }
  | { status: "idempotency_conflict" };

type TransitionInput = {
  conversationId: string;
  actorUserId: string;
  clientRequestId: string;
  /** 原因/交接说明；仅 manual takeover 允许省略（=takeoverReason，默认不要求填写） */
  summary?: string;
  /** 主动接管时的会话修订号（审计用，不参与条件更新） */
  sourceConversationRevision?: number;
  sourceIp: string;
  briefing?: schema.HandoffBriefing;
  /** 仅 created：定向路由到专家队列（intent 映射/客服转交目标）；null/缺省 = 通用 */
  assignedQueueId?: string | null;
  /** Agent 发起 Handoff 时排除该 Turn，由调用方写入具体 terminal reason。 */
  agentTurnId?: string;
};

type HandoffTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

type HandoffDatabase = NodePgDatabase<typeof schema> | HandoffTransaction;

export type EscalateHandoffResult =
  | {
      status: "ok";
      replayed: boolean;
      handoff: typeof schema.handoffStates.$inferSelect;
    }
  | {
      status:
        | "invalid_transition"
        | "not_assignee"
        | "revision_conflict"
        | "idempotency_conflict";
    };

/** 创建人工接管请求（进入待认领状态） */
export async function createHandoff(
  db: HandoffDatabase,
  input: TransitionInput,
): Promise<HandoffResult> {
  return transition(db, "created", input);
}

/**
 * Creates an Agent-owned handoff inside a caller-owned transaction.
 *
 * The public createHandoff API intentionally opens its own transaction for
 * HTTP callers. Agent outcome commands already own the conversation lock and
 * must commit the Handoff, AgentTurn, Case and Message facts together, so they
 * use this seam instead.
 */
export async function createHandoffInTransaction(
  transaction: HandoffTransaction,
  input: TransitionInput,
): Promise<HandoffResult> {
  return transitionInTransaction(transaction, "created", input);
}

/**
 * Moves an owned human handoff back to the pending specialist queue.
 *
 * This operation deliberately accepts an existing transaction. Collaboration
 * request and audit writes must commit or roll back together with the Handoff
 * state, cycle, and event transition.
 */
export async function escalateHandoff(
  transaction: HandoffTransaction,
  input: {
    conversationId: string;
    handoffId: string;
    actorUserId: string;
    queueId: string;
    reason: string;
    expectedHandoffRevision: number;
    clientRequestId: string;
  },
): Promise<EscalateHandoffResult> {
  await lockConversationOwnership(transaction, input.conversationId);

  const [priorEvent] = await transaction
    .select()
    .from(schema.handoffEvents)
    .where(eq(schema.handoffEvents.clientRequestId, input.clientRequestId))
    .limit(1);
  if (priorEvent) {
    if (
      priorEvent.conversationId !== input.conversationId ||
      priorEvent.actorUserId !== input.actorUserId ||
      priorEvent.eventType !== "escalated" ||
      priorEvent.summary !== input.reason
    ) {
      return { status: "idempotency_conflict" };
    }
    const [replayed] = await transaction
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    return replayed
      ? { status: "ok", replayed: true, handoff: replayed }
      : { status: "invalid_transition" };
  }

  const [current] = await transaction
    .select()
    .from(schema.handoffStates)
    .where(eq(schema.handoffStates.conversationId, input.conversationId))
    .limit(1);
  if (!current) return { status: "not_assignee" };
  if (current.handoffRevision !== input.expectedHandoffRevision) {
    return { status: "revision_conflict" };
  }
  if (
    current.cycleId !== input.handoffId ||
    current.status !== "in_progress" ||
    current.assignedUserId !== input.actorUserId
  ) {
    return { status: "not_assignee" };
  }

  const now = new Date();
  const [updated] = await transaction
    .update(schema.handoffStates)
    .set({
      status: "pending",
      assignedUserId: null,
      assignedQueueId: input.queueId,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.handoffStates.conversationId, input.conversationId),
        eq(schema.handoffStates.cycleId, current.cycleId),
        eq(schema.handoffStates.handoffRevision, input.expectedHandoffRevision),
        eq(schema.handoffStates.status, "in_progress"),
        eq(schema.handoffStates.assignedUserId, input.actorUserId),
      ),
    )
    .returning();
  if (!updated) return { status: "invalid_transition" };

  await transaction
    .update(schema.handoffCycles)
    .set({
      status: "pending",
      assignedUserId: null,
      assignedQueueId: input.queueId,
      updatedAt: now,
    })
    .where(eq(schema.handoffCycles.cycleId, current.cycleId));
  await transaction.insert(schema.handoffEvents).values({
    eventId: collaborationEscalationEventId(input.clientRequestId),
    cycleId: current.cycleId,
    conversationId: input.conversationId,
    actorUserId: input.actorUserId,
    eventType: "escalated",
    fromStatus: "in_progress",
    toStatus: "pending",
    clientRequestId: input.clientRequestId,
    summary: input.reason,
  });

  return { status: "ok", replayed: false, handoff: updated };
}

/** 认领待处理的人工接管请求 */
export async function acceptHandoff(
  db: NodePgDatabase<typeof schema>,
  input: TransitionInput,
): Promise<HandoffResult> {
  return transition(db, "accepted", input);
}

/**
 * Starts a new human-owned cycle without first exposing a pending queue item.
 * This is deliberately a server-side transition: a client must never compose
 * create + accept, which would leave a claim race between those requests.
 */
export async function takeOverHandoff(
  db: NodePgDatabase<typeof schema>,
  input: TransitionInput,
): Promise<HandoffResult> {
  return transition(db, "manual_taken_over", input);
}

/** 解决人工接管（恢复正常 Agent 自动回复） */
export async function resolveHandoff(
  db: NodePgDatabase<typeof schema>,
  input: TransitionInput,
): Promise<HandoffResult> {
  return transition(db, "resolved", input);
}

/** 释放人工接管（退回待认领队列） */
export async function releaseHandoff(
  db: NodePgDatabase<typeof schema>,
  input: TransitionInput,
): Promise<HandoffResult> {
  return transition(db, "released", input);
}

/** 列出可转交的活跃用户（排除当前操作者） */
export async function listHandoffAssignees(
  db: NodePgDatabase<typeof schema>,
  actorUserId: string,
) {
  return db
    .select({ userId: schema.users.userId, username: schema.users.username })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.status, "active"),
        ne(schema.users.userId, actorUserId),
      ),
    )
    .orderBy(schema.users.username);
}

/** 将人工接管转交给其他用户 */
export async function transferHandoff(
  db: NodePgDatabase<typeof schema>,
  input: TransitionInput & { targetUserId: string },
): Promise<HandoffResult> {
  return db.transaction(async (transaction) => {
    const [prior] = await transaction
      .select()
      .from(schema.handoffEvents)
      .where(eq(schema.handoffEvents.clientRequestId, input.clientRequestId))
      .limit(1);
    if (prior) {
      if (
        prior.conversationId !== input.conversationId ||
        prior.actorUserId !== input.actorUserId ||
        prior.eventType !== "transferred" ||
        prior.targetUserId !== input.targetUserId ||
        prior.summary !== input.summary
      ) {
        return { status: "idempotency_conflict" };
      }
      const [state] = await transaction
        .select()
        .from(schema.handoffStates)
        .where(eq(schema.handoffStates.conversationId, input.conversationId))
        .limit(1);
      return state
        ? { status: "ok", replayed: true, handoff: state }
        : { status: "invalid_transition" };
    }

    if (input.targetUserId === input.actorUserId)
      return { status: "invalid_transition" };
    const [target] = await transaction
      .select({ userId: schema.users.userId })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.userId, input.targetUserId),
          eq(schema.users.status, "active"),
        ),
      )
      .limit(1);
    if (!target) return { status: "assignee_not_found" };

    const [current] = await transaction
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    if (!current || current.status !== "in_progress")
      return { status: "invalid_transition" };
    if (current.assignedUserId !== input.actorUserId)
      return { status: "not_assignee" };

    const now = new Date();
    const [handoff] = await transaction
      .update(schema.handoffStates)
      .set({
        assignedUserId: input.targetUserId,
        reason: input.summary,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.handoffStates.conversationId, input.conversationId),
          eq(schema.handoffStates.status, "in_progress"),
          eq(schema.handoffStates.assignedUserId, input.actorUserId),
        ),
      )
      .returning();
    if (!handoff) return { status: "not_assignee" };
    await transaction
      .update(schema.handoffCycles)
      .set({ assignedUserId: input.targetUserId, updatedAt: now })
      .where(eq(schema.handoffCycles.cycleId, handoff.cycleId));
    const eventId = handoffEventId(input.clientRequestId);
    await transaction.insert(schema.handoffEvents).values({
      eventId,
      cycleId: handoff.cycleId,
      conversationId: input.conversationId,
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      eventType: "transferred",
      fromStatus: "in_progress",
      toStatus: "in_progress",
      clientRequestId: input.clientRequestId,
      summary: input.summary ?? "",
    });
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: input.actorUserId,
      eventType: "handoff.transferred",
      subjectType: "handoff_event",
      subjectId: eventId,
      sourceIp: input.sourceIp,
      metadata: {
        conversationId: input.conversationId,
        targetUserId: input.targetUserId,
        clientRequestId: input.clientRequestId,
      },
    });
    await enqueueHandoffTransferNotification(
      transaction,
      input.conversationId,
      input.targetUserId,
      eventId,
    );
    return { status: "ok", replayed: false, handoff };
  });
}

/** 获取会话的完整人工接管信息，包括当前状态、简报、周期和事件历史 */
export async function getHandoff(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
) {
  const states = await db
    .select()
    .from(schema.handoffStates)
    .where(eq(schema.handoffStates.conversationId, conversationId))
    .limit(1);
  if (!states[0]) return undefined;
  const events = await db
    .select()
    .from(schema.handoffEvents)
    .where(eq(schema.handoffEvents.conversationId, conversationId))
    .orderBy(schema.handoffEvents.createdAt);
  const cycles = await db
    .select()
    .from(schema.handoffCycles)
    .where(eq(schema.handoffCycles.conversationId, conversationId))
    .orderBy(schema.handoffCycles.createdAt);
  const currentCycle = cycles.find(
    (cycle) => cycle.cycleId === states[0]?.cycleId,
  );
  return {
    state: states[0],
    briefing: currentCycle?.briefing ?? null,
    cycles: cycles.map(({ briefing, ...cycle }) => {
      void briefing;
      return cycle;
    }),
    events,
  };
}

/** 检查会话的 Agent 是否因人工接管而暂停 */
export async function isAgentPaused(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ agentPaused: schema.handoffStates.agentPaused })
    .from(schema.handoffStates)
    .where(eq(schema.handoffStates.conversationId, conversationId))
    .limit(1);
  return rows[0]?.agentPaused ?? false;
}

/**
 * 人工接管状态转换的核心逻辑。
 * 处理幂等性校验、状态机验证、Agent Turn 取消、确认消息发送和审计记录。
 */
async function transition(
  db: HandoffDatabase,
  type: TransitionType,
  input: TransitionInput,
): Promise<HandoffResult> {
  return db.transaction(async (transaction) =>
    transitionInTransaction(transaction, type, input),
  );
}

async function transitionInTransaction(
  transaction: HandoffTransaction,
  type: TransitionType,
  input: TransitionInput,
): Promise<HandoffResult> {
  // ownership 锁：与 Agent 出站落库、人工回复、其他归属变更串行化，
  // 取锁后再读状态即为权威，结构上杜绝「Human owner 存在时 Agent 仍外发」。
  await lockConversationOwnership(transaction, input.conversationId);
  const priorEvents = await transaction
    .select()
    .from(schema.handoffEvents)
    .where(eq(schema.handoffEvents.clientRequestId, input.clientRequestId))
    .limit(1);
  const prior = priorEvents[0];
  if (prior) {
    if (
      prior.conversationId !== input.conversationId ||
      prior.actorUserId !== input.actorUserId ||
      prior.eventType !== type ||
      prior.summary !== (input.summary ?? "")
    ) {
      return { status: "idempotency_conflict" };
    }
    const replayStates = await transaction
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    const replayState = replayStates[0];
    return replayState
      ? { status: "ok", replayed: true, handoff: replayState }
      : { status: "invalid_transition" };
  }

  const conversations = await transaction
    .select({ conversationId: schema.conversations.conversationId })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, input.conversationId))
    .limit(1);
  if (!conversations[0]) return { status: "conversation_not_found" };

  const states = await transaction
    .select()
    .from(schema.handoffStates)
    .where(eq(schema.handoffStates.conversationId, input.conversationId))
    .limit(1);
  const current = states[0];
  const now = new Date();
  const createdCycleId = handoffCycleId(input.clientRequestId);
  const beginsCycle = type === "created" || type === "manual_taken_over";
  const nextHandoffRevision = (current?.handoffRevision ?? 0) + 1;
  const nextStatus =
    type === "created"
      ? "pending"
      : type === "accepted" || type === "manual_taken_over"
        ? "in_progress"
        : type === "released"
          ? "pending"
          : "resolved";

  if (
    type === "manual_taken_over" &&
    current?.status === "in_progress" &&
    current.assignedUserId
  ) {
    const [assignee] = await transaction
      .select({
        userId: schema.users.userId,
        username: schema.users.username,
      })
      .from(schema.users)
      .where(eq(schema.users.userId, current.assignedUserId))
      .limit(1);
    return {
      status: "already_claimed",
      handoff: current,
      assignee,
    };
  }
  if (beginsCycle && current?.agentPaused) {
    return { status: "invalid_transition" };
  }
  if (
    (type === "accepted" || type === "manual_taken_over") &&
    current?.assignedQueueId
  ) {
    return { status: "invalid_transition" };
  }
  if (
    (type === "resolved" || type === "released") &&
    current?.status !== "in_progress"
  ) {
    return { status: "invalid_transition" };
  }
  if (
    (type === "resolved" || type === "released") &&
    current?.assignedUserId !== input.actorUserId
  ) {
    return { status: "not_assignee" };
  }

  const nextValues =
    type === "created"
      ? {
          status: nextStatus,
          reason: input.summary,
          assignedUserId: null,
          assignedQueueId: input.assignedQueueId ?? null,
          createdByUserId: input.actorUserId,
          resolvedByUserId: null,
          resolution: null,
          agentPaused: true,
          createdAt: now,
          acceptedAt: null,
          resolvedAt: null,
          updatedAt: now,
        }
      : type === "manual_taken_over"
        ? {
            status: nextStatus,
            reason: input.summary ?? "",
            assignedUserId: input.actorUserId,
            assignedQueueId: null,
            createdByUserId: input.actorUserId,
            resolvedByUserId: null,
            resolution: null,
            agentPaused: true,
            createdAt: now,
            acceptedAt: now,
            resolvedAt: null,
            updatedAt: now,
          }
        : type === "accepted"
          ? {
              status: nextStatus,
              assignedUserId: input.actorUserId,
              assignedQueueId: null,
              acceptedAt: now,
              updatedAt: now,
            }
          : type === "released"
            ? {
                status: nextStatus,
                assignedUserId: null,
                assignedQueueId: null,
                acceptedAt: null,
                updatedAt: now,
              }
            : {
                status: nextStatus,
                assignedQueueId: null,
                resolvedByUserId: input.actorUserId,
                resolution: input.summary,
                agentPaused: false,
                resolvedAt: now,
                updatedAt: now,
              };

  let updated: (typeof schema.handoffStates.$inferSelect)[];
  if (beginsCycle) {
    const createValues = {
      cycleId: createdCycleId,
      status: nextStatus,
      contractVersion: 2,
      handoffRevision: nextHandoffRevision,
      reason: input.summary ?? "",
      assignedUserId: type === "manual_taken_over" ? input.actorUserId : null,
      assignedQueueId:
        type === "created" ? (input.assignedQueueId ?? null) : null,
      createdByUserId: input.actorUserId,
      resolvedByUserId: null,
      resolution: null,
      agentPaused: true,
      createdAt: now,
      acceptedAt: type === "manual_taken_over" ? now : null,
      pendingSince: type === "created" ? now : null,
      resolvedAt: null,
      updatedAt: now,
    };
    await transaction.insert(schema.handoffCycles).values({
      cycleId: createdCycleId,
      conversationId: input.conversationId,
      status: nextStatus,
      contractVersion: 2,
      handoffRevision: nextHandoffRevision,
      reason: input.summary ?? "",
      briefing: input.briefing ?? null,
      assignedUserId: type === "manual_taken_over" ? input.actorUserId : null,
      assignedQueueId:
        type === "created" ? (input.assignedQueueId ?? null) : null,
      createdByUserId: input.actorUserId,
      resolvedByUserId: null,
      resolution: null,
      createdAt: now,
      acceptedAt: type === "manual_taken_over" ? now : null,
      resolvedAt: null,
      updatedAt: now,
    });
    updated = await transaction
      .insert(schema.handoffStates)
      .values({
        conversationId: input.conversationId,
        ...createValues,
      })
      .onConflictDoUpdate({
        target: schema.handoffStates.conversationId,
        set: createValues,
        where: eq(schema.handoffStates.agentPaused, false),
      })
      .returning();
  } else {
    updated = await transaction
      .update(schema.handoffStates)
      .set(nextValues)
      .where(
        and(
          eq(schema.handoffStates.conversationId, input.conversationId),
          type === "accepted"
            ? and(
                eq(schema.handoffStates.status, "pending"),
                isNull(schema.handoffStates.assignedUserId),
              )
            : and(
                eq(schema.handoffStates.status, "in_progress"),
                eq(schema.handoffStates.assignedUserId, input.actorUserId),
              ),
        ),
      )
      .returning();
  }
  const handoff = updated[0];
  if (!handoff) {
    if (beginsCycle) {
      await transaction
        .delete(schema.handoffCycles)
        .where(eq(schema.handoffCycles.cycleId, createdCycleId));
    }
    if (type === "resolved" || type === "released") {
      const latest = await transaction
        .select({
          status: schema.handoffStates.status,
          assignedUserId: schema.handoffStates.assignedUserId,
        })
        .from(schema.handoffStates)
        .where(eq(schema.handoffStates.conversationId, input.conversationId))
        .limit(1);
      if (
        latest[0]?.status === "in_progress" &&
        latest[0].assignedUserId !== input.actorUserId
      ) {
        return { status: "not_assignee" };
      }
    }
    if (type !== "accepted" && type !== "manual_taken_over") {
      return { status: "invalid_transition" };
    }
    const claimed = await transaction
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    const currentHandoff = claimed[0];
    if (
      !currentHandoff ||
      currentHandoff.status !== "in_progress" ||
      !currentHandoff.assignedUserId
    ) {
      return { status: "invalid_transition" };
    }
    const assignees = await transaction
      .select({
        userId: schema.users.userId,
        username: schema.users.username,
      })
      .from(schema.users)
      .where(eq(schema.users.userId, currentHandoff.assignedUserId))
      .limit(1);
    return {
      status: "already_claimed",
      handoff: currentHandoff,
      assignee: assignees[0],
    };
  }

  if (!beginsCycle) {
    const cycleValues =
      type === "accepted"
        ? {
            status: "in_progress",
            assignedUserId: input.actorUserId,
            acceptedAt: now,
            updatedAt: now,
          }
        : type === "released"
          ? {
              status: "pending",
              assignedUserId: null,
              acceptedAt: null,
              updatedAt: now,
            }
          : {
              status: "resolved",
              resolvedByUserId: input.actorUserId,
              resolution: input.summary,
              resolvedAt: now,
              updatedAt: now,
            };
    await transaction
      .update(schema.handoffCycles)
      .set(cycleValues)
      .where(eq(schema.handoffCycles.cycleId, handoff.cycleId));
  }

  if (beginsCycle) {
    const eventId = handoffEventId(input.clientRequestId);
    // tool_planned 一并压制：否则 worker 会在事务外先执行一次工具，
    // 再于事务内才发现 handoff 激活（未来写入型工具会造成真实副作用）
    await new AgentTurnService(transaction).suppressHandoffForConversation(
      input.conversationId,
      "handoff_active",
      input.agentTurnId,
    );
    await transaction
      .update(schema.messages)
      .set({
        sendState: "cancelled_handoff",
        sendError: "handoff_active",
        sendUpdatedAt: now,
      })
      .where(
        and(
          eq(schema.messages.conversationId, input.conversationId),
          eq(schema.messages.actorType, "agent"),
          eq(schema.messages.sendState, "pending"),
        ),
      );
    if (type === "created") {
      await transaction
        .insert(schema.messages)
        .values({
          messageId: `handoff-message:${eventId}`,
          conversationId: input.conversationId,
          channelEventId: null,
          channelMessageId: null,
          direction: "outbound",
          actorType: "system",
          actorId: "system-agent",
          contentType: "text",
          channelType: 1,
          text: handoffConfirmation(),
          isSelf: true,
          processingState: "not_applicable",
          sendState: "pending",
          idempotencyKey: `handoff-message:${eventId}`,
          occurredAt: now,
          traceId: `handoff:${eventId}`,
        })
        .onConflictDoNothing();
      // 定向路由时通知只发给队列成员/持标签客服；通用创建则全员可见
      await enqueuePendingHandoffNotifications(
        transaction,
        input.conversationId,
        handoff.cycleId,
        "created",
        input.assignedQueueId ?? null,
      );
    }
  }

  const eventId = handoffEventId(input.clientRequestId);
  await transaction.insert(schema.handoffEvents).values({
    eventId,
    cycleId: handoff.cycleId,
    conversationId: input.conversationId,
    actorUserId: input.actorUserId,
    eventType: type,
    fromStatus: current?.status ?? null,
    toStatus: nextStatus,
    clientRequestId: input.clientRequestId,
    summary: input.summary ?? "",
    // 补齐 outcome 语义：mobile 端操作失败后可经 request-outcomes 查询到真实结果
    outcomeStatus: "succeeded",
    responseSnapshot: { handoff },
  });
  await transaction.insert(schema.auditEvents).values({
    auditId: randomUUID(),
    actorUserId: input.actorUserId,
    eventType: `handoff.${type}`,
    subjectType: "handoff_event",
    subjectId: eventId,
    sourceIp: input.sourceIp,
    metadata: {
      handoffEventId: eventId,
      clientRequestId: input.clientRequestId,
      ...(type === "manual_taken_over"
        ? {
            takeoverType: "manual",
            ...(input.sourceConversationRevision !== undefined
              ? {
                  sourceConversationRevision: String(
                    input.sourceConversationRevision,
                  ),
                }
              : {}),
          }
        : {}),
    },
  });
  return { status: "ok", replayed: false, handoff };
}

/** 人工接管确认话术：平台固定文案（不允许模型自由措辞） */
function handoffConfirmation(): string {
  return "已收到您的情况，已转交专人跟进。";
}

/** 基于客户端请求ID生成确定性事件ID */
function handoffEventId(clientRequestId: string): string {
  return `handoff-event:${createHash("sha256").update(clientRequestId).digest("hex")}`;
}

/** 基于客户端请求ID生成确定性周期ID */
function handoffCycleId(clientRequestId: string): string {
  return `handoff-cycle:${createHash("sha256").update(clientRequestId).digest("hex")}`;
}

function collaborationEscalationEventId(clientRequestId: string): string {
  const requestId = `collaboration:${createHash("sha256")
    .update(clientRequestId)
    .digest("hex")}`;
  return `collaboration-event:${createHash("sha256")
    .update(`escalated:${requestId}`)
    .digest("hex")}`;
}

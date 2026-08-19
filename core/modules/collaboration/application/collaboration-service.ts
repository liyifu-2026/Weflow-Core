/**
 * 协作服务
 *
 * 管理客服之间的协作请求（协助请求和升级请求）。
 * 支持请求的创建、认领、回答和关闭完整生命周期。
 * 升级请求会同步更新交接（handoff）状态，
 * 将会话从当前客服转移到专业队列。
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { escalateHandoff } from "../../handoff/application/handoff-service.js";

type Db = NodePgDatabase<typeof schema>;
type RequestKind = "assist" | "escalation";

/** 协作操作的返回结果联合类型 */
export type CollaborationResult =
  | {
      status: "ok";
      replayed: boolean;
      request: typeof schema.collaborationRequests.$inferSelect;
    }
  | {
      status:
        | "conversation_not_found"
        | "handoff_not_found"
        | "not_assignee"
        | "queue_not_found"
        | "not_queue_member"
        | "invalid_transition"
        | "duplicate_active_request"
        | "idempotency_conflict";
    };

/** 查询所有启用的专业队列 */
export async function listSpecialistQueues(db: Db) {
  return db
    .select()
    .from(schema.specialistQueues)
    .where(eq(schema.specialistQueues.isActive, true));
}

/**
 * 查询会话的协作请求列表
 *
 * 只返回当前用户可见的请求：创建者、认领者、交接负责人
 * 或所在队列成员才能看到。
 */
export async function listConversationCollaboration(
  db: Db,
  input: { conversationId: string; actorUserId: string },
) {
  const [handoff] = await db
    .select({ assignedUserId: schema.handoffStates.assignedUserId })
    .from(schema.handoffStates)
    .where(eq(schema.handoffStates.conversationId, input.conversationId))
    .limit(1);
  const rows = await db
    .select()
    .from(schema.collaborationRequests)
    .where(
      eq(schema.collaborationRequests.conversationId, input.conversationId),
    );
  const visible: typeof rows = [];
  for (const row of rows) {
    const [membership] = await db
      .select({ membershipId: schema.queueMembers.membershipId })
      .from(schema.queueMembers)
      .where(
        and(
          eq(schema.queueMembers.queueId, row.queueId),
          eq(schema.queueMembers.userId, input.actorUserId),
          eq(schema.queueMembers.isActive, true),
        ),
      )
      .limit(1);
    if (
      row.createdByUserId === input.actorUserId ||
      row.claimedByUserId === input.actorUserId ||
      handoff?.assignedUserId === input.actorUserId ||
      membership
    ) {
      visible.push(row);
    }
  }
  return visible;
}

/**
 * 创建协作请求
 *
 * 验证交接状态、队列有效性后创建请求。
 * 升级请求会将交接状态从 in_progress 改为 pending，
 * 并指派到目标专业队列。支持幂等性。
 */
export async function createCollaborationRequest(
  db: Db,
  input: {
    conversationId: string;
    handoffId: string;
    actorUserId: string;
    kind: RequestKind;
    queueId: string;
    reason: string;
    clientRequestId: string;
    sourceIp: string;
  },
): Promise<CollaborationResult> {
  return db.transaction(async (transaction) => {
    const [prior] = await transaction
      .select()
      .from(schema.collaborationRequests)
      .where(
        eq(schema.collaborationRequests.clientRequestId, input.clientRequestId),
      )
      .limit(1);
    if (prior) {
      if (
        prior.conversationId !== input.conversationId ||
        prior.createdByUserId !== input.actorUserId ||
        prior.kind !== input.kind ||
        prior.queueId !== input.queueId ||
        prior.reason !== input.reason
      )
        return { status: "idempotency_conflict" };
      return { status: "ok", replayed: true, request: prior };
    }
    const [handoff] = await transaction
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    if (!handoff) return { status: "handoff_not_found" };
    if (
      handoff.cycleId !== input.handoffId ||
      handoff.status !== "in_progress" ||
      handoff.assignedUserId !== input.actorUserId
    )
      return { status: "not_assignee" };
    const [queue] = await transaction
      .select()
      .from(schema.specialistQueues)
      .where(
        and(
          eq(schema.specialistQueues.queueId, input.queueId),
          eq(schema.specialistQueues.isActive, true),
        ),
      )
      .limit(1);
    if (!queue) return { status: "queue_not_found" };
    if (input.kind === "escalation") {
      const [active] = await transaction
        .select({ requestId: schema.collaborationRequests.requestId })
        .from(schema.collaborationRequests)
        .where(
          and(
            eq(
              schema.collaborationRequests.conversationId,
              input.conversationId,
            ),
            eq(schema.collaborationRequests.kind, "escalation"),
            inArray(schema.collaborationRequests.status, [
              "pending",
              "claimed",
              "answered",
            ]),
          ),
        )
        .limit(1);
      if (active) return { status: "duplicate_active_request" };
    }
    const requestId = collaborationRequestId(input.clientRequestId);
    const [created] = await transaction
      .insert(schema.collaborationRequests)
      .values({
        requestId,
        conversationId: input.conversationId,
        handoffCycleId: handoff.cycleId,
        kind: input.kind,
        status: "pending",
        queueId: input.queueId,
        createdByUserId: input.actorUserId,
        reason: input.reason,
        claimSummary: claimSummary(input.reason),
        clientRequestId: input.clientRequestId,
      })
      .returning();
    if (!created) return { status: "invalid_transition" };
    await transaction.insert(schema.collaborationRequestParticipants).values({
      participantId: randomUUID(),
      requestId,
      userId: input.actorUserId,
    });
    if (input.kind === "escalation") {
      const escalated = await escalateHandoff(transaction, {
        conversationId: input.conversationId,
        handoffId: handoff.cycleId,
        actorUserId: input.actorUserId,
        queueId: input.queueId,
        reason: input.reason,
        expectedHandoffRevision: handoff.handoffRevision,
        clientRequestId: input.clientRequestId,
      });
      if (escalated.status !== "ok") {
        if (escalated.status === "revision_conflict") {
          return { status: "invalid_transition" };
        }
        return { status: escalated.status };
      }
    }
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: input.actorUserId,
      eventType: `collaboration.${input.kind}.created`,
      subjectType: "collaboration_request",
      subjectId: requestId,
      sourceIp: input.sourceIp,
      metadata: {
        conversationId: input.conversationId,
        queueId: input.queueId,
      },
    });
    return { status: "ok", replayed: false, request: created };
  });
}

/**
 * 认领协作请求
 *
 * 队列成员可以认领 pending 状态的请求。
 * 升级请求认领会同步更新交接状态，将指派人设为认领者。
 */
export async function claimCollaborationRequest(
  db: Db,
  input: {
    requestId: string;
    actorUserId: string;
    clientRequestId: string;
    sourceIp: string;
  },
): Promise<CollaborationResult> {
  return db.transaction(async (transaction) => {
    const [request] = await transaction
      .select()
      .from(schema.collaborationRequests)
      .where(eq(schema.collaborationRequests.requestId, input.requestId))
      .limit(1);
    if (!request) return { status: "handoff_not_found" };
    const [membership] = await transaction
      .select({ membershipId: schema.queueMembers.membershipId })
      .from(schema.queueMembers)
      .where(
        and(
          eq(schema.queueMembers.queueId, request.queueId),
          eq(schema.queueMembers.userId, input.actorUserId),
          eq(schema.queueMembers.isActive, true),
        ),
      )
      .limit(1);
    if (!membership) return { status: "not_queue_member" };
    if (
      request.status === "claimed" &&
      request.claimedByUserId === input.actorUserId
    ) {
      return { status: "ok", replayed: true, request };
    }
    if (request.status !== "pending") return { status: "invalid_transition" };
    if (request.kind === "escalation") {
      const [handoff] = await transaction
        .select()
        .from(schema.handoffStates)
        .where(eq(schema.handoffStates.conversationId, request.conversationId))
        .limit(1);
      if (
        !handoff ||
        handoff.cycleId !== request.handoffCycleId ||
        handoff.status !== "pending" ||
        handoff.assignedQueueId !== request.queueId
      )
        return { status: "invalid_transition" };
    }
    const [claimed] = await transaction
      .update(schema.collaborationRequests)
      .set({
        status: "claimed",
        claimedByUserId: input.actorUserId,
        claimedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.collaborationRequests.requestId, input.requestId),
          eq(schema.collaborationRequests.status, "pending"),
        ),
      )
      .returning();
    if (!claimed) return { status: "invalid_transition" };
    await transaction
      .insert(schema.collaborationRequestParticipants)
      .values({
        participantId: randomUUID(),
        requestId: request.requestId,
        userId: input.actorUserId,
      })
      .onConflictDoNothing();
    if (request.kind === "escalation") {
      await transaction
        .update(schema.handoffStates)
        .set({
          status: "in_progress",
          assignedUserId: input.actorUserId,
          assignedQueueId: null,
          acceptedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.handoffStates.conversationId, request.conversationId));
      await transaction
        .update(schema.handoffCycles)
        .set({
          status: "in_progress",
          assignedUserId: input.actorUserId,
          assignedQueueId: null,
          acceptedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.handoffCycles.cycleId, request.handoffCycleId));
      await transaction.insert(schema.handoffEvents).values({
        eventId: collaborationHandoffEventId("claimed", request.requestId),
        cycleId: request.handoffCycleId,
        conversationId: request.conversationId,
        actorUserId: input.actorUserId,
        eventType: "queue_claimed",
        fromStatus: "pending",
        toStatus: "in_progress",
        clientRequestId: input.clientRequestId,
        summary: "专业队列领取升级会话",
      });
    }
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: input.actorUserId,
      eventType: `collaboration.${request.kind}.claimed`,
      subjectType: "collaboration_request",
      subjectId: request.requestId,
      sourceIp: input.sourceIp,
      metadata: { queueId: request.queueId },
    });
    return { status: "ok", replayed: false, request: claimed };
  });
}

/** 回答协作请求（仅认领者可操作） */
export async function answerCollaborationRequest(
  db: Db,
  input: {
    requestId: string;
    actorUserId: string;
    resolution: string;
    sourceIp: string;
  },
): Promise<CollaborationResult> {
  return db.transaction(async (transaction) => {
    const [request] = await transaction
      .select()
      .from(schema.collaborationRequests)
      .where(eq(schema.collaborationRequests.requestId, input.requestId))
      .limit(1);
    if (!request) return { status: "handoff_not_found" };
    if (
      request.status !== "claimed" ||
      request.claimedByUserId !== input.actorUserId
    )
      return { status: "invalid_transition" };
    const [answered] = await transaction
      .update(schema.collaborationRequests)
      .set({
        status: "answered",
        resolution: input.resolution,
        answeredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.collaborationRequests.requestId, input.requestId))
      .returning();
    if (!answered) return { status: "invalid_transition" };
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: input.actorUserId,
      eventType: `collaboration.${request.kind}.answered`,
      subjectType: "collaboration_request",
      subjectId: request.requestId,
      sourceIp: input.sourceIp,
      metadata: {},
    });
    return { status: "ok", replayed: false, request: answered };
  });
}

/** 关闭已回答的协作请求（创建者或认领者可操作） */
export async function closeCollaborationRequest(
  db: Db,
  input: { requestId: string; actorUserId: string; sourceIp: string },
): Promise<CollaborationResult> {
  return db.transaction(async (transaction) => {
    const [request] = await transaction
      .select()
      .from(schema.collaborationRequests)
      .where(eq(schema.collaborationRequests.requestId, input.requestId))
      .limit(1);
    if (!request) return { status: "handoff_not_found" };
    if (
      request.status !== "answered" ||
      (request.createdByUserId !== input.actorUserId &&
        request.claimedByUserId !== input.actorUserId)
    )
      return { status: "invalid_transition" };
    const [closed] = await transaction
      .update(schema.collaborationRequests)
      .set({ status: "closed", closedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.collaborationRequests.requestId, input.requestId))
      .returning();
    if (!closed) return { status: "invalid_transition" };
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: input.actorUserId,
      eventType: `collaboration.${request.kind}.closed`,
      subjectType: "collaboration_request",
      subjectId: request.requestId,
      sourceIp: input.sourceIp,
      metadata: {},
    });
    return { status: "ok", replayed: false, request: closed };
  });
}

/** 取消待领取的协作请求（仅创建者、仅 pending 状态可操作） */
export async function cancelCollaborationRequest(
  db: Db,
  input: { requestId: string; actorUserId: string; sourceIp: string },
): Promise<CollaborationResult> {
  return db.transaction(async (transaction) => {
    const [request] = await transaction
      .select()
      .from(schema.collaborationRequests)
      .where(eq(schema.collaborationRequests.requestId, input.requestId))
      .limit(1);
    if (!request) return { status: "handoff_not_found" };
    if (
      request.status !== "pending" ||
      request.createdByUserId !== input.actorUserId
    )
      return { status: "invalid_transition" };
    const [cancelled] = await transaction
      .update(schema.collaborationRequests)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(schema.collaborationRequests.requestId, input.requestId))
      .returning();
    if (!cancelled) return { status: "invalid_transition" };
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: input.actorUserId,
      eventType: `collaboration.${request.kind}.cancelled`,
      subjectType: "collaboration_request",
      subjectId: request.requestId,
      sourceIp: input.sourceIp,
      metadata: {},
    });
    return { status: "ok", replayed: false, request: cancelled };
  });
}

/** 根据客户端请求 ID 生成确定性协作请求 ID */
function collaborationRequestId(clientRequestId: string): string {
  return `collaboration:${createHash("sha256").update(clientRequestId).digest("hex")}`;
}

function collaborationHandoffEventId(
  eventType: "claimed",
  requestId: string,
): string {
  return `collaboration-event:${createHash("sha256")
    .update(`${eventType}:${requestId}`)
    .digest("hex")}`;
}

/**
 * 生成协作请求的脱敏摘要
 *
 * 隐藏 URL 和联系方式等敏感信息，截断到 160 字符。
 * 用于向非相关人员展示请求概要。
 */
function claimSummary(reason: string): string {
  const redacted = reason
    .replace(/https?:\/\/\S+/gi, "[已隐藏链接]")
    .replace(/[+()\-\s\d]{7,}/g, "[已隐藏联系方式]")
    .trim();
  return redacted.length > 160 ? `${redacted.slice(0, 157)}…` : redacted;
}

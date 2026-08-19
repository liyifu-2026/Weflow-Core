import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { lockConversationOwnership } from "../../../infrastructure/postgres/ownership-lock.js";
import {
  enqueueHandoffTransferNotification,
  enqueuePendingHandoffNotifications,
} from "../../notifications/application/notification-outbox.js";

type Db = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Db["transaction"]>[0] extends (
  transaction: infer T,
) => Promise<unknown>
  ? T
  : never;

export const GENERAL_HANDOFF_QUEUE_ID = "queue-general";
export const DIRECT_TRANSFER_ACCEPTANCE_MS = 15 * 60 * 1_000;
export const CUSTOMER_NO_RESPONSE_MIN_MS = 30 * 60 * 1_000;

export const mobileHandoffCapabilities = {
  mobileHandoffInbox: true,
  handoffRevision: true,
  structuredBrief: true,
  transferCycle: true,
  transferToUser: true,
  transferToQueue: true,
  transferFallback: true,
  humanFinish: true,
  handoffOutcomeQuery: true,
  requestOutcome: true,
  structuredSuggestion: true,
  suggestionV2: true,
  mobileManualTakeover: true,
  /** 信息名片（显示名/专家标签/改密入口）；旧 Server2 为 false */
  agentProfile: true,
} as const;

export type HumanResult =
  | "resolved_by_human"
  | "answered_question"
  | "information_collected"
  | "customer_no_response"
  | "other";

export type MobileOperation =
  | "claim_handoff"
  | "reject_transfer"
  | "transfer_handoff"
  | "finish_handoff"
  | "take_over";

type MobileWriteResult =
  | { status: "ok"; replayed: boolean; handoff: MobileHandoffState }
  | {
      status:
        | "not_found"
        | "invalid_transition"
        | "not_assignee"
        | "not_eligible"
        | "revision_conflict"
        | "conversation_revision_conflict"
        | "idempotency_conflict"
        | "customer_no_response_not_eligible";
      handoff?: MobileHandoffState;
    };

export type MobileHandoffState = {
  conversationId: string;
  cycleId: string;
  handoffRevision: number;
  status:
    "HANDOFF_PENDING" | "TRANSFER_PENDING" | "HUMAN_ACTIVE" | "HUMAN_FINISHED";
  assignedUserId: string | null;
  assignedQueueId: string | null;
  targetUserId: string | null;
  targetQueueId: string | null;
  ownerDisplayName: string | null;
  targetDisplayName: string | null;
  canClaim: boolean;
  canRejectTransfer: boolean;
  createdAt: string;
  acceptedAt: string | null;
  transferredAt: string | null;
  pendingSince: string | null;
  acceptBy: string | null;
  fallbackQueueId: string | null;
  finishedAt: string | null;
  resolvedAt: string | null;
};

export function getMobileCapabilities() {
  return mobileHandoffCapabilities;
}

export async function getMobileHandoffDetail(
  db: Db,
  conversationId: string,
  actorUserId: string,
) {
  await reconcileExpiredTransfers(db, conversationId);
  const [state] = await db
    .select()
    .from(schema.handoffStates)
    .where(
      and(
        eq(schema.handoffStates.conversationId, conversationId),
        eq(schema.handoffStates.contractVersion, 2),
      ),
    )
    .limit(1);
  if (!state) return undefined;
  const cycles = await db
    .select()
    .from(schema.handoffCycles)
    .where(eq(schema.handoffCycles.conversationId, conversationId))
    .orderBy(asc(schema.handoffCycles.createdAt));
  const currentCycle = cycles.find((cycle) => cycle.cycleId === state.cycleId);
  return {
    state: await presentState(db, state, actorUserId),
    cycles: cycles.map(presentCycle),
    briefing: currentCycle?.briefing ?? null,
    // 当前 cycle 的转交说明（转交给当前负责人的留言），无则 null
    activeTransferNote: currentCycle?.transferContext?.transferReason || null,
  };
}

export async function listMobileHandoffInbox(
  db: Db,
  actorUserId: string,
  limit: number,
) {
  await reconcileExpiredTransfers(db);
  const rows = await db.execute<{
    conversationId: string;
    channel: string;
    latestMessageAt: Date | string | null;
    latestMessageText: string | null;
    contactId: string;
    channelContactId: string;
    channelDisplayName: string | null;
    channelNickname: string | null;
    channelRemark: string | null;
    avatarUrl: string | null;
    sharedAlias: string | null;
    handoffStatus: string;
    handoffRevision: number;
    assignedUserId: string | null;
    assignedQueueId: string | null;
    targetUserId: string | null;
    targetQueueId: string | null;
    pendingSince: Date | string | null;
    reason: string;
    briefing: schema.HandoffBriefing | null;
    transferContext: schema.StructuredTransferContext | null;
    ownerName: string | null;
    targetUserName: string | null;
    assignedQueueName: string | null;
    targetQueueName: string | null;
  }>(sql`
    SELECT
      c.conversation_id AS "conversationId",
      c.channel AS "channel",
      latest.occurred_at AS "latestMessageAt",
      latest.text AS "latestMessageText",
      p.contact_id AS "contactId",
      p.channel_contact_id AS "channelContactId",
      p.channel_display_name AS "channelDisplayName",
      p.channel_nickname AS "channelNickname",
      p.channel_remark AS "channelRemark",
      p.avatar_url AS "avatarUrl",
      p.shared_alias AS "sharedAlias",
      h.status AS "handoffStatus",
      h.handoff_revision AS "handoffRevision",
      h.assigned_user_id AS "assignedUserId",
      h.assigned_queue_id AS "assignedQueueId",
      h.target_user_id AS "targetUserId",
      h.target_queue_id AS "targetQueueId",
      h.pending_since AS "pendingSince",
      h.reason AS "reason",
      cycle.briefing AS "briefing",
      cycle.transfer_context AS "transferContext",
      owner.username AS "ownerName",
      target_user.username AS "targetUserName",
      assigned_queue.display_name AS "assignedQueueName",
      target_queue.display_name AS "targetQueueName"
    FROM handoff.states h
    JOIN conversation.conversations c ON c.conversation_id = h.conversation_id
    JOIN conversation.contact_profiles p ON p.contact_id = c.contact_id
    JOIN handoff.cycles cycle ON cycle.cycle_id = h.cycle_id
    LEFT JOIN identity.users owner ON owner.user_id = h.assigned_user_id
    LEFT JOIN identity.users target_user ON target_user.user_id = h.target_user_id
    LEFT JOIN collaboration.specialist_queues assigned_queue ON assigned_queue.queue_id = h.assigned_queue_id
    LEFT JOIN collaboration.specialist_queues target_queue ON target_queue.queue_id = h.target_queue_id
    LEFT JOIN conversation.case_states case_state ON case_state.conversation_id = h.conversation_id
    LEFT JOIN LATERAL (
      SELECT m.occurred_at, m.text
      FROM conversation.messages m
      WHERE m.conversation_id = h.conversation_id
      ORDER BY m.occurred_at DESC, m.message_id DESC
      LIMIT 1
    ) latest ON true
    WHERE h.contract_version = 2
      AND h.agent_paused = true
      AND (
        (h.status = 'in_progress' AND h.assigned_user_id = ${actorUserId})
        OR (h.status = 'transfer_pending' AND h.target_user_id = ${actorUserId})
        OR (
          h.status = 'pending'
          AND (
            h.assigned_queue_id IS NULL
            OR h.assigned_queue_id = ${GENERAL_HANDOFF_QUEUE_ID}
            OR EXISTS (
              SELECT 1 FROM collaboration.queue_members member
              WHERE member.queue_id = h.assigned_queue_id
                AND member.user_id = ${actorUserId}
                AND member.is_active = true
            )
            OR EXISTS (
              SELECT 1
              FROM identity.users tagged_user
              JOIN collaboration.specialist_queues tagged_queue
                ON tagged_queue.queue_id = h.assigned_queue_id
              WHERE tagged_user.user_id = ${actorUserId}
                AND tagged_user.tags ? tagged_queue.key
            )
          )
        )
      )
    ORDER BY
      CASE COALESCE(case_state.risk_level, 'low')
        WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1
      END DESC,
      COALESCE(h.pending_since, h.created_at) ASC,
      latest.occurred_at DESC NULLS LAST
    LIMIT ${limit}
  `);
  return rows.rows.map((row) => ({
    conversationId: row.conversationId,
    channel: row.channel,
    latestMessageAt: isoValue(row.latestMessageAt) ?? undefined,
    contact: {
      contactId: row.contactId,
      channelContactId: row.channelContactId,
      channelDisplayName: row.channelDisplayName,
      channelNickname: row.channelNickname,
      channelRemark: row.channelRemark,
      avatarUrl: row.avatarUrl,
      sharedAlias: row.sharedAlias,
    },
    latestMessage: { text: row.latestMessageText ?? "" },
    handoff: {
      status: canonicalStatus(row.handoffStatus),
      handoffRevision: row.handoffRevision,
      assignedUserId: row.assignedUserId,
      assignedQueueId: row.assignedQueueId,
      targetUserId: row.targetUserId,
      targetQueueId: row.targetQueueId,
      pendingSince: isoValue(row.pendingSince),
      problemSummary: row.briefing?.problemSummary ?? null,
      handoffReason:
        row.briefing?.version === 2 ? row.briefing.handoffReason : row.reason,
      attentionReason:
        row.handoffStatus === "transfer_pending"
          ? "等待你接手"
          : row.briefing?.version === 2
            ? row.briefing.handoffReason
            : row.reason,
      transferNote: row.transferContext?.transferReason || null,
      assignedUser: row.ownerName ? { username: row.ownerName } : null,
      targetUser: row.targetUserName ? { username: row.targetUserName } : null,
      assignedQueue: row.assignedQueueName
        ? { displayName: row.assignedQueueName }
        : null,
      targetQueue: row.targetQueueName
        ? { displayName: row.targetQueueName }
        : null,
    },
  }));
}

export async function listMobileAssignees(db: Db, actorUserId: string) {
  return db
    .select({
      userId: schema.users.userId,
      displayName: sql<
        string | null
      >`coalesce(${schema.users.displayName}, ${schema.users.username})`,
      username: schema.users.username,
    })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.status, "active"),
        sql`${schema.users.userId} <> ${actorUserId}`,
      ),
    )
    .orderBy(asc(schema.users.username))
    .then((users) =>
      users.map((user) => ({ ...user, canReceiveHandoff: true })),
    );
}

export async function listMobileQueueTargets(db: Db) {
  return db
    .select({
      queueId: schema.specialistQueues.queueId,
      displayName: schema.specialistQueues.displayName,
      shortDescription: schema.specialistQueues.description,
    })
    .from(schema.specialistQueues)
    .where(
      and(
        eq(schema.specialistQueues.isActive, true),
        sql`${schema.specialistQueues.queueId} <> ${GENERAL_HANDOFF_QUEUE_ID}`,
      ),
    )
    .orderBy(asc(schema.specialistQueues.displayName))
    .then((queues) =>
      queues.map((queue) => ({ ...queue, canReceiveHandoff: true })),
    );
}

export async function getTransferPreview(
  db: Db,
  input: {
    conversationId: string;
    actorUserId: string;
    targetType: "user" | "queue";
    targetId: string;
  },
) {
  const [state] = await db
    .select()
    .from(schema.handoffStates)
    .where(eq(schema.handoffStates.conversationId, input.conversationId))
    .limit(1);
  if (
    !state ||
    state.contractVersion !== 2 ||
    state.status !== "in_progress" ||
    state.assignedUserId !== input.actorUserId
  )
    return undefined;
  if (!(await validTarget(db, input.targetType, input.targetId)))
    return undefined;
  const [cycle] = await db
    .select()
    .from(schema.handoffCycles)
    .where(eq(schema.handoffCycles.cycleId, state.cycleId))
    .limit(1);
  if (!cycle?.briefing || cycle.briefing.version !== 2) return undefined;
  const [conversation] = await db
    .select({ revision: schema.conversations.revision })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, input.conversationId))
    .limit(1);
  if (!conversation) return undefined;
  return {
    context: {
      ...cycle.briefing,
      sourceConversationRevision: conversation.revision,
      sourceCycleId: state.cycleId,
      transferReason: "",
      transferredByUserId: input.actorUserId,
      targetType: input.targetType,
      targetId: input.targetId,
    } satisfies schema.StructuredTransferContext,
    handoffRevision: state.handoffRevision,
  };
}

export async function claimMobileHandoff(
  db: Db,
  input: {
    conversationId: string;
    actorUserId: string;
    expectedHandoffRevision: number;
    clientRequestId: string;
    sourceIp: string;
  },
): Promise<MobileWriteResult> {
  await reconcileExpiredTransfers(db, input.conversationId);
  return db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    const replay = await replayOperation(transaction, "claim_handoff", input);
    if (replay) return replay;
    const [current] = await transaction
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    if (!current || current.contractVersion !== 2)
      return { status: "not_found" };
    if (current.handoffRevision !== input.expectedHandoffRevision)
      return {
        status: "revision_conflict",
        handoff: await presentState(transaction, current, input.actorUserId),
      };
    if (!(await canClaim(transaction, current, input.actorUserId)))
      return { status: "not_eligible" };
    const now = new Date();
    const [updated] = await transaction
      .update(schema.handoffStates)
      .set({
        status: "in_progress",
        handoffRevision: current.handoffRevision + 1,
        assignedUserId: input.actorUserId,
        assignedQueueId: null,
        targetUserId: null,
        targetQueueId: null,
        acceptBy: null,
        fallbackQueueId: null,
        acceptedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.handoffStates.conversationId, input.conversationId),
          eq(
            schema.handoffStates.handoffRevision,
            input.expectedHandoffRevision,
          ),
          inArray(schema.handoffStates.status, ["pending", "transfer_pending"]),
          isNull(schema.handoffStates.assignedUserId),
        ),
      )
      .returning();
    if (!updated) return { status: "revision_conflict" };
    await transaction
      .update(schema.handoffCycles)
      .set({
        status: "in_progress",
        handoffRevision: updated.handoffRevision,
        assignedUserId: input.actorUserId,
        assignedQueueId: null,
        acceptedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.handoffCycles.cycleId, updated.cycleId));
    await recordOperation(transaction, {
      operation: "claim_handoff",
      input,
      state: updated,
      eventType: "claimed",
      fromStatus: current.status,
      summary: "接手处理",
    });
    return {
      status: "ok",
      replayed: false,
      handoff: await presentState(transaction, updated, input.actorUserId),
    };
  });
}

export async function transferMobileHandoff(
  db: Db,
  input: {
    conversationId: string;
    actorUserId: string;
    targetType: "user" | "queue";
    targetId: string;
    transferReason?: string | undefined;
    sourceConversationRevision: number;
    expectedHandoffRevision: number;
    clientRequestId: string;
    sourceIp: string;
  },
): Promise<MobileWriteResult> {
  const transferReason = input.transferReason ?? "";
  return db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    const replay = await replayOperation(
      transaction,
      "transfer_handoff",
      input,
    );
    if (replay) return replay;
    const [current] = await transaction
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    if (!current || current.contractVersion !== 2)
      return { status: "not_found" };
    if (current.handoffRevision !== input.expectedHandoffRevision)
      return { status: "revision_conflict" };
    if (
      current.status !== "in_progress" ||
      current.assignedUserId !== input.actorUserId
    )
      return { status: "not_assignee" };
    const [conversation] = await transaction
      .select({ revision: schema.conversations.revision })
      .from(schema.conversations)
      .where(eq(schema.conversations.conversationId, input.conversationId))
      .limit(1);
    if (conversation?.revision !== input.sourceConversationRevision)
      return { status: "conversation_revision_conflict" };
    if (!(await validTarget(transaction, input.targetType, input.targetId)))
      return { status: "not_eligible" };
    const [sourceCycle] = await transaction
      .select()
      .from(schema.handoffCycles)
      .where(eq(schema.handoffCycles.cycleId, current.cycleId))
      .limit(1);
    if (!sourceCycle?.briefing || sourceCycle.briefing.version !== 2)
      return { status: "invalid_transition" };
    const context: schema.StructuredTransferContext = {
      ...sourceCycle.briefing,
      sourceCycleId: current.cycleId,
      transferReason,
      transferredByUserId: input.actorUserId,
      targetType: input.targetType,
      targetId: input.targetId,
    };
    const now = new Date();
    const nextRevision = current.handoffRevision + 1;
    const fallbackQueueId =
      input.targetType === "user"
        ? await fallbackQueueForUser(transaction, input.targetId)
        : null;
    const acceptBy =
      input.targetType === "user"
        ? new Date(now.getTime() + DIRECT_TRANSFER_ACCEPTANCE_MS)
        : null;
    const nextCycleId = cycleIdFor(input.clientRequestId, "transfer");
    await transaction
      .update(schema.handoffCycles)
      .set({
        status: "finished",
        result: "transferred",
        transferredByUserId: input.actorUserId,
        targetType: input.targetType,
        targetId: input.targetId,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.handoffCycles.cycleId, current.cycleId));
    await transaction.insert(schema.handoffCycles).values({
      cycleId: nextCycleId,
      conversationId: input.conversationId,
      status: input.targetType === "user" ? "transfer_pending" : "pending",
      contractVersion: 2,
      handoffRevision: nextRevision,
      reason: transferReason,
      briefing: sourceCycle.briefing,
      transferContext: context,
      assignedUserId: null,
      assignedQueueId: input.targetType === "queue" ? input.targetId : null,
      createdByUserId: input.actorUserId,
      transferredByUserId: input.actorUserId,
      targetType: input.targetType,
      targetId: input.targetId,
      createdAt: now,
      updatedAt: now,
    });
    const [updated] = await transaction
      .update(schema.handoffStates)
      .set({
        cycleId: nextCycleId,
        status: input.targetType === "user" ? "transfer_pending" : "pending",
        handoffRevision: nextRevision,
        reason: transferReason,
        assignedUserId: null,
        assignedQueueId: input.targetType === "queue" ? input.targetId : null,
        targetUserId: input.targetType === "user" ? input.targetId : null,
        targetQueueId: input.targetType === "queue" ? input.targetId : null,
        transferredAt: now,
        pendingSince: now,
        acceptBy,
        fallbackQueueId,
        acceptedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.handoffStates.conversationId, input.conversationId),
          eq(
            schema.handoffStates.handoffRevision,
            input.expectedHandoffRevision,
          ),
          eq(schema.handoffStates.status, "in_progress"),
          eq(schema.handoffStates.assignedUserId, input.actorUserId),
        ),
      )
      .returning();
    if (!updated) return { status: "revision_conflict" };
    await recordOperation(transaction, {
      operation: "transfer_handoff",
      input,
      state: updated,
      eventType: "transfer_requested",
      fromStatus: current.status,
      summary: transferReason,
    });
    if (input.targetType === "user") {
      await enqueueHandoffTransferNotification(
        transaction,
        input.conversationId,
        input.targetId,
        eventIdFor(input.clientRequestId),
      );
    } else {
      await enqueuePendingHandoffNotifications(
        transaction,
        input.conversationId,
        nextCycleId,
        "queue-transfer",
        input.targetId,
      );
    }
    return {
      status: "ok",
      replayed: false,
      handoff: await presentState(transaction, updated, input.actorUserId),
    };
  });
}

export async function rejectMobileTransfer(
  db: Db,
  input: {
    conversationId: string;
    actorUserId: string;
    expectedHandoffRevision: number;
    clientRequestId: string;
    sourceIp: string;
  },
): Promise<MobileWriteResult> {
  return moveDirectTransferToFallback(db, input, "reject_transfer");
}

export async function finishMobileHandoff(
  db: Db,
  input: {
    conversationId: string;
    actorUserId: string;
    expectedHandoffRevision: number;
    clientRequestId: string;
    result?: HumanResult;
    sourceIp: string;
  },
): Promise<MobileWriteResult> {
  return db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    const replay = await replayOperation(transaction, "finish_handoff", input);
    if (replay) return replay;
    const [current] = await transaction
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    if (!current || current.contractVersion !== 2)
      return { status: "not_found" };
    if (current.handoffRevision !== input.expectedHandoffRevision)
      return { status: "revision_conflict" };
    if (
      current.status !== "in_progress" ||
      current.assignedUserId !== input.actorUserId
    )
      return { status: "not_assignee" };
    const context = await inferFinishContext(transaction, input.conversationId);
    const result = input.result ?? context.inferredResult;
    if (!result || (context.requiresConfirmation && !input.result))
      return { status: "invalid_transition" };
    if (
      result === "customer_no_response" &&
      !(await customerNoResponseEligible(transaction, input.conversationId))
    )
      return { status: "customer_no_response_not_eligible" };
    const now = new Date();
    const nextRevision = current.handoffRevision + 1;
    const [updated] = await transaction
      .update(schema.handoffStates)
      .set({
        status: "resolved",
        handoffRevision: nextRevision,
        result,
        resolvedByUserId: input.actorUserId,
        agentPaused: false,
        finishedAt: now,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.handoffStates.conversationId, input.conversationId),
          eq(
            schema.handoffStates.handoffRevision,
            input.expectedHandoffRevision,
          ),
          eq(schema.handoffStates.status, "in_progress"),
          eq(schema.handoffStates.assignedUserId, input.actorUserId),
        ),
      )
      .returning();
    if (!updated) return { status: "revision_conflict" };
    await transaction
      .update(schema.handoffCycles)
      .set({
        status: "finished",
        handoffRevision: nextRevision,
        result,
        resolvedByUserId: input.actorUserId,
        finishedAt: now,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.handoffCycles.cycleId, current.cycleId));
    // 人工结束后重置 Case 状态：清除 requiresHuman 与 handoff 阶段，
    // 否则 Agent 接续时上下文仍为"需要人工"，会无限转人工（P0 修复）。
    // 注意：requiresHuman 由模型独立输出，可能与 stage='handoff' 不同步，
    // 因此重置条件以 requiresHuman=true 为准，覆盖所有 stage 组合。
    await transaction
      .update(schema.caseStates)
      .set({ requiresHuman: false, stage: "answering", updatedAt: now })
      .where(
        and(
          eq(schema.caseStates.conversationId, input.conversationId),
          eq(schema.caseStates.requiresHuman, true),
        ),
      );
    await transaction.insert(schema.handoffResolutionSummaryJobs).values({
      jobId: `resolution:${current.cycleId}`,
      conversationId: input.conversationId,
      cycleId: current.cycleId,
    });
    await recordOperation(transaction, {
      operation: "finish_handoff",
      input,
      state: updated,
      eventType: "finished",
      fromStatus: current.status,
      summary: result,
    });
    return {
      status: "ok",
      replayed: false,
      handoff: await presentState(transaction, updated, input.actorUserId),
    };
  });
}

export async function inferFinishContext(db: Db, conversationId: string) {
  if (await customerNoResponseEligible(db, conversationId)) {
    return {
      inferredResult: "customer_no_response" as const,
      confidence: 0.9,
      requiresConfirmation: false,
    };
  }
  const [humanReply] = await db
    .select({ messageId: schema.messages.messageId })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.actorType, "user"),
        eq(schema.messages.direction, "outbound"),
      ),
    )
    .limit(1);
  return humanReply
    ? {
        inferredResult: "answered_question" as const,
        confidence: 0.7,
        requiresConfirmation: false,
      }
    : { inferredResult: null, confidence: null, requiresConfirmation: true };
}

export async function getMobileOperationOutcome(
  db: Db,
  actorUserId: string,
  operation: MobileOperation,
  clientRequestId: string,
) {
  const [event] = await db
    .select()
    .from(schema.handoffEvents)
    .where(
      and(
        eq(schema.handoffEvents.clientRequestId, clientRequestId),
        eq(schema.handoffEvents.actorUserId, actorUserId),
        eq(schema.handoffEvents.eventType, eventTypeFor(operation)),
      ),
    )
    .limit(1);
  if (!event) return { status: "not_found" as const };
  return {
    status:
      event.outcomeStatus === "succeeded"
        ? ("succeeded" as const)
        : ("failed" as const),
    result: event.responseSnapshot ?? undefined,
  };
}

export async function reconcileExpiredTransfers(
  db: Db,
  conversationId?: string,
): Promise<number> {
  const expired = await db
    .select({
      conversationId: schema.handoffStates.conversationId,
      handoffRevision: schema.handoffStates.handoffRevision,
      targetUserId: schema.handoffStates.targetUserId,
    })
    .from(schema.handoffStates)
    .where(
      and(
        eq(schema.handoffStates.contractVersion, 2),
        eq(schema.handoffStates.status, "transfer_pending"),
        lte(schema.handoffStates.acceptBy, new Date()),
        conversationId
          ? eq(schema.handoffStates.conversationId, conversationId)
          : undefined,
      ),
    );
  let count = 0;
  for (const state of expired) {
    const result = await moveDirectTransferToFallback(
      db,
      {
        conversationId: state.conversationId,
        actorUserId: "system",
        expectedHandoffRevision: state.handoffRevision,
        clientRequestId: randomUUID(),
        sourceIp: "server2",
      },
      "timeout",
    );
    if (result.status === "ok") count += 1;
  }
  return count;
}

/** 定向路由队列的待认领任务超过该时限无人认领后，回落到通用队列（全员可见） */
export const QUEUE_ROUTED_ESCALATION_MS = 15 * 60 * 1_000;

/**
 * 定向路由兜底：pending 且 assignedQueueId 指向专家队列的任务，
 * pendingSince 超过时限仍无人认领时解除队列限制，回归全员可见并重发通知。
 * 防止「没有客服持有该标签」时任务永远无人可见。
 */
export async function reconcileUnclaimedQueuedHandoffs(
  db: Db,
): Promise<number> {
  const cutoff = new Date(Date.now() - QUEUE_ROUTED_ESCALATION_MS);
  const stale = await db
    .select({
      conversationId: schema.handoffStates.conversationId,
      cycleId: schema.handoffStates.cycleId,
      handoffRevision: schema.handoffStates.handoffRevision,
      assignedQueueId: schema.handoffStates.assignedQueueId,
    })
    .from(schema.handoffStates)
    .where(
      and(
        eq(schema.handoffStates.contractVersion, 2),
        eq(schema.handoffStates.status, "pending"),
        eq(schema.handoffStates.agentPaused, true),
        isNotNull(schema.handoffStates.assignedQueueId),
        ne(schema.handoffStates.assignedQueueId, GENERAL_HANDOFF_QUEUE_ID),
        lte(schema.handoffStates.pendingSince, cutoff),
      ),
    );
  let escalated = 0;
  for (const state of stale) {
    if (
      state.assignedQueueId &&
      (await escalateQueuedHandoffToGeneral(db, {
        ...state,
        assignedQueueId: state.assignedQueueId,
      }))
    )
      escalated += 1;
  }
  return escalated;
}

async function escalateQueuedHandoffToGeneral(
  db: Db,
  state: {
    conversationId: string;
    cycleId: string;
    handoffRevision: number;
    assignedQueueId: string;
  },
): Promise<boolean> {
  return db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, state.conversationId);
    const now = new Date();
    const nextRevision = state.handoffRevision + 1;
    const [updated] = await transaction
      .update(schema.handoffStates)
      .set({
        assignedQueueId: null,
        handoffRevision: nextRevision,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.handoffStates.conversationId, state.conversationId),
          eq(schema.handoffStates.handoffRevision, state.handoffRevision),
          eq(schema.handoffStates.status, "pending"),
          eq(schema.handoffStates.assignedQueueId, state.assignedQueueId),
        ),
      )
      .returning();
    if (!updated) return false;
    await transaction
      .update(schema.handoffCycles)
      .set({ assignedQueueId: null, updatedAt: now })
      .where(
        and(
          eq(schema.handoffCycles.cycleId, state.cycleId),
          eq(schema.handoffCycles.status, "pending"),
        ),
      );
    const clientRequestId = `escalate-${createHash("sha256")
      .update(`${state.conversationId}:${String(state.handoffRevision)}`)
      .digest("hex")
      .slice(0, 27)}`;
    const eventId = eventIdFor(clientRequestId);
    await transaction.insert(schema.handoffEvents).values({
      eventId,
      cycleId: state.cycleId,
      conversationId: state.conversationId,
      actorUserId: "system",
      targetUserId: null,
      eventType: "routing_escalated",
      fromStatus: "pending",
      toStatus: "pending",
      clientRequestId,
      requestHash: createHash("sha256").update(clientRequestId).digest("hex"),
      responseSnapshot: snapshotState(updated),
      outcomeStatus: "succeeded",
      summary: "定向队列超时无人认领，回落到通用人工队列",
    });
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: null,
      eventType: "handoff.routing_escalated",
      subjectType: "handoff_event",
      subjectId: eventId,
      sourceIp: "server2",
      metadata: {
        conversationId: state.conversationId,
        cycleId: state.cycleId,
        queueId: state.assignedQueueId,
      },
    });
    // 解除队列限制后全员可见，重发待认领通知
    await enqueuePendingHandoffNotifications(
      transaction,
      state.conversationId,
      state.cycleId,
      "routing-escalated",
    );
    return true;
  });
}

export async function processResolutionSummaryJobs(db: Db): Promise<number> {
  const jobs = await db
    .select()
    .from(schema.handoffResolutionSummaryJobs)
    .where(eq(schema.handoffResolutionSummaryJobs.status, "pending"))
    .orderBy(asc(schema.handoffResolutionSummaryJobs.createdAt))
    .limit(10);
  let completed = 0;
  for (const job of jobs) {
    const claimed = await db
      .update(schema.handoffResolutionSummaryJobs)
      .set({
        status: "running",
        attempt: job.attempt + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.handoffResolutionSummaryJobs.jobId, job.jobId),
          eq(schema.handoffResolutionSummaryJobs.status, "pending"),
        ),
      )
      .returning({ jobId: schema.handoffResolutionSummaryJobs.jobId });
    if (!claimed[0]) continue;
    try {
      const [cycle] = await db
        .select()
        .from(schema.handoffCycles)
        .where(eq(schema.handoffCycles.cycleId, job.cycleId))
        .limit(1);
      const [conversation] = await db
        .select({ revision: schema.conversations.revision })
        .from(schema.conversations)
        .where(eq(schema.conversations.conversationId, job.conversationId))
        .limit(1);
      if (!cycle || !conversation) throw new Error("summary_source_missing");
      const [latestHumanReply] = await db
        .select({ text: schema.messages.text })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.conversationId, job.conversationId),
            eq(schema.messages.actorType, "user"),
            eq(schema.messages.direction, "outbound"),
          ),
        )
        .orderBy(
          desc(schema.messages.occurredAt),
          desc(schema.messages.messageId),
        )
        .limit(1);
      const summary: schema.ResolutionSummary = {
        text: resolutionSummaryText(cycle, latestHumanReply?.text),
        generatedAt: new Date().toISOString(),
        sourceConversationRevision: conversation.revision,
        generationMethod: "server_rules_v1",
      };
      await db.transaction(async (transaction) => {
        await transaction
          .update(schema.handoffCycles)
          .set({
            resolutionSummary: summary,
            resolution: summary.text,
            updatedAt: new Date(),
          })
          .where(eq(schema.handoffCycles.cycleId, job.cycleId));
        await transaction
          .update(schema.handoffStates)
          .set({
            resolutionSummary: summary,
            resolution: summary.text,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.handoffStates.conversationId, job.conversationId),
              eq(schema.handoffStates.cycleId, job.cycleId),
            ),
          );
        await transaction
          .update(schema.handoffResolutionSummaryJobs)
          .set({ status: "completed", errorCode: null, updatedAt: new Date() })
          .where(eq(schema.handoffResolutionSummaryJobs.jobId, job.jobId));
      });
      completed += 1;
    } catch {
      await db
        .update(schema.handoffResolutionSummaryJobs)
        .set({
          status: job.attempt + 1 >= 3 ? "failed" : "pending",
          errorCode: "summary_generation_failed",
          updatedAt: new Date(),
        })
        .where(eq(schema.handoffResolutionSummaryJobs.jobId, job.jobId));
    }
  }
  return completed;
}

/** Durable rows are the source of truth; this timer only advances pending work. */
export function startMobileHandoffMaintenance(
  db: Db,
  logger: Pick<Logger, "error">,
) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileExpiredTransfers(db);
      await reconcileUnclaimedQueuedHandoffs(db);
      await processResolutionSummaryJobs(db);
    } catch (error) {
      // 单次维护失败不得终止 core 进程（unhandledRejection 会直接杀进程）
      logger.error({ err: error }, "Mobile handoff maintenance tick failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), 15_000);
  timer.unref();
  void run();
  return () => {
    clearInterval(timer);
  };
}

export async function latestHumanCycleAgentContext(
  db: Db,
  conversationId: string,
) {
  const [cycle] = await db
    .select({
      result: schema.handoffCycles.result,
      resolutionSummary: schema.handoffCycles.resolutionSummary,
      briefing: schema.handoffCycles.briefing,
      customerConstraints: schema.handoffCycles.customerConstraints,
    })
    .from(schema.handoffCycles)
    .where(
      and(
        eq(schema.handoffCycles.conversationId, conversationId),
        eq(schema.handoffCycles.contractVersion, 2),
        eq(schema.handoffCycles.status, "finished"),
        sql`${schema.handoffCycles.result} <> 'transferred'`,
      ),
    )
    .orderBy(desc(schema.handoffCycles.finishedAt))
    .limit(1);
  if (!cycle) return null;
  return {
    humanResult: cycle.result,
    resolutionSummary: cycle.resolutionSummary?.text ?? null,
    confirmedFacts: cycle.briefing?.confirmedFacts ?? [],
    unresolvedItems: cycle.briefing?.unresolvedItems ?? [],
    customerConstraints: cycle.customerConstraints,
  };
}

export async function recordHandoffQualityFeedback(
  db: Db,
  input: {
    conversationId: string;
    cycleId: string;
    actorUserId: string;
    clientRequestId: string;
    kind: "brief_incorrect" | "human_message_review";
    briefVersion?: number;
    messageId?: string;
  },
) {
  const [cycle] = await db
    .select({
      cycleId: schema.handoffCycles.cycleId,
      briefing: schema.handoffCycles.briefing,
    })
    .from(schema.handoffCycles)
    .where(
      and(
        eq(schema.handoffCycles.cycleId, input.cycleId),
        eq(schema.handoffCycles.conversationId, input.conversationId),
      ),
    )
    .limit(1);
  if (!cycle) return { status: "not_found" as const };
  if (
    input.kind === "brief_incorrect" &&
    input.briefVersion !== cycle.briefing?.version
  )
    return { status: "revision_conflict" as const };
  if (input.kind === "human_message_review") {
    const [message] = await db
      .select({ messageId: schema.messages.messageId })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.messageId, input.messageId ?? ""),
          eq(schema.messages.conversationId, input.conversationId),
          eq(schema.messages.actorType, "user"),
          eq(schema.messages.actorId, input.actorUserId),
        ),
      )
      .limit(1);
    if (!message) return { status: "not_found" as const };
  }
  const feedbackId = `handoff-feedback:${createHash("sha256").update(input.clientRequestId).digest("hex")}`;
  const inserted = await db
    .insert(schema.handoffQualityFeedback)
    .values({
      feedbackId,
      conversationId: input.conversationId,
      cycleId: input.cycleId,
      actorUserId: input.actorUserId,
      kind: input.kind,
      clientRequestId: input.clientRequestId,
      ...(input.briefVersion === undefined
        ? {}
        : { briefVersion: input.briefVersion }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    })
    .onConflictDoNothing()
    .returning({ feedbackId: schema.handoffQualityFeedback.feedbackId });
  if (inserted[0]) return { status: "ok" as const, replayed: false };
  const [existing] = await db
    .select()
    .from(schema.handoffQualityFeedback)
    .where(
      eq(schema.handoffQualityFeedback.clientRequestId, input.clientRequestId),
    )
    .limit(1);
  if (
    existing?.conversationId !== input.conversationId ||
    existing.cycleId !== input.cycleId ||
    existing.actorUserId !== input.actorUserId ||
    existing.kind !== input.kind ||
    existing.messageId !== (input.messageId ?? null) ||
    existing.briefVersion !== (input.briefVersion ?? null)
  )
    return { status: "idempotency_conflict" as const };
  return { status: "ok" as const, replayed: true };
}

async function moveDirectTransferToFallback(
  db: Db,
  input: {
    conversationId: string;
    actorUserId: string;
    expectedHandoffRevision: number;
    clientRequestId: string;
    sourceIp: string;
  },
  reason: "reject_transfer" | "timeout",
): Promise<MobileWriteResult> {
  return db.transaction(async (transaction) => {
    await lockConversationOwnership(transaction, input.conversationId);
    if (reason === "reject_transfer") {
      const replay = await replayOperation(
        transaction,
        "reject_transfer",
        input,
      );
      if (replay) return replay;
    }
    const [current] = await transaction
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, input.conversationId))
      .limit(1);
    if (!current || current.contractVersion !== 2)
      return { status: "not_found" };
    if (current.handoffRevision !== input.expectedHandoffRevision)
      return { status: "revision_conflict" };
    if (current.status !== "transfer_pending")
      return { status: "invalid_transition" };
    if (
      reason === "reject_transfer" &&
      current.targetUserId !== input.actorUserId
    )
      return { status: "not_assignee" };
    if (
      reason === "timeout" &&
      (!current.acceptBy || current.acceptBy > new Date())
    )
      return { status: "invalid_transition" };
    const [sourceCycle] = await transaction
      .select()
      .from(schema.handoffCycles)
      .where(eq(schema.handoffCycles.cycleId, current.cycleId))
      .limit(1);
    if (!sourceCycle?.briefing) return { status: "invalid_transition" };
    const now = new Date();
    const fallbackQueueId = current.fallbackQueueId ?? GENERAL_HANDOFF_QUEUE_ID;
    const nextRevision = current.handoffRevision + 1;
    const nextCycleId = cycleIdFor(input.clientRequestId, reason);
    await transaction
      .update(schema.handoffCycles)
      .set({
        status: "finished",
        result: "transferred",
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.handoffCycles.cycleId, current.cycleId));
    await transaction.insert(schema.handoffCycles).values({
      cycleId: nextCycleId,
      conversationId: input.conversationId,
      status: "pending",
      contractVersion: 2,
      handoffRevision: nextRevision,
      reason:
        reason === "timeout" ? "具体客服未在时限内接手" : "目标客服无法接手",
      briefing: sourceCycle.briefing,
      transferContext: sourceCycle.transferContext,
      assignedQueueId: fallbackQueueId,
      createdByUserId: reason === "timeout" ? "system" : input.actorUserId,
      targetType: "queue",
      targetId: fallbackQueueId,
      createdAt: now,
      updatedAt: now,
    });
    const [updated] = await transaction
      .update(schema.handoffStates)
      .set({
        cycleId: nextCycleId,
        status: "pending",
        handoffRevision: nextRevision,
        reason:
          reason === "timeout" ? "具体客服未在时限内接手" : "目标客服无法接手",
        assignedUserId: null,
        assignedQueueId: fallbackQueueId,
        targetUserId: null,
        targetQueueId: fallbackQueueId,
        pendingSince: now,
        acceptBy: null,
        fallbackQueueId: null,
        acceptedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.handoffStates.conversationId, input.conversationId),
          eq(
            schema.handoffStates.handoffRevision,
            input.expectedHandoffRevision,
          ),
          eq(schema.handoffStates.status, "transfer_pending"),
        ),
      )
      .returning();
    if (!updated) return { status: "revision_conflict" };
    await recordOperation(transaction, {
      operation: reason === "timeout" ? "reject_transfer" : "reject_transfer",
      input,
      state: updated,
      eventType:
        reason === "timeout" ? "transfer_expired" : "transfer_rejected",
      fromStatus: current.status,
      summary: reason,
    });
    await enqueuePendingHandoffNotifications(
      transaction,
      input.conversationId,
      nextCycleId,
      reason,
      fallbackQueueId,
    );
    return {
      status: "ok",
      replayed: false,
      handoff: await presentState(transaction, updated, input.actorUserId),
    };
  });
}

async function customerNoResponseEligible(db: Db, conversationId: string) {
  const messages = await db
    .select({
      direction: schema.messages.direction,
      actorType: schema.messages.actorType,
      occurredAt: schema.messages.occurredAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(desc(schema.messages.occurredAt), desc(schema.messages.messageId))
    .limit(2);
  const latest = messages[0];
  return (
    latest !== undefined &&
    latest.direction === "outbound" &&
    latest.actorType === "user" &&
    Date.now() - latest.occurredAt.getTime() >= CUSTOMER_NO_RESPONSE_MIN_MS
  );
}

async function validTarget(db: Db, type: "user" | "queue", id: string) {
  if (type === "user") {
    const [user] = await db
      .select({ userId: schema.users.userId })
      .from(schema.users)
      .where(
        and(eq(schema.users.userId, id), eq(schema.users.status, "active")),
      )
      .limit(1);
    return Boolean(user);
  }
  const [queue] = await db
    .select({ queueId: schema.specialistQueues.queueId })
    .from(schema.specialistQueues)
    .where(
      and(
        eq(schema.specialistQueues.queueId, id),
        eq(schema.specialistQueues.isActive, true),
      ),
    )
    .limit(1);
  return Boolean(queue);
}

async function fallbackQueueForUser(db: Db, userId: string) {
  const [membership] = await db
    .select({ queueId: schema.queueMembers.queueId })
    .from(schema.queueMembers)
    .innerJoin(
      schema.specialistQueues,
      and(
        eq(schema.specialistQueues.queueId, schema.queueMembers.queueId),
        eq(schema.specialistQueues.isActive, true),
      ),
    )
    .where(
      and(
        eq(schema.queueMembers.userId, userId),
        eq(schema.queueMembers.isActive, true),
      ),
    )
    .orderBy(asc(schema.specialistQueues.key))
    .limit(1);
  return membership?.queueId ?? GENERAL_HANDOFF_QUEUE_ID;
}

/** 客服是否匹配某队列：协作队列成员 或 名片标签包含该队列 key（标签与队列同源） */
async function actorMatchesQueue(
  db: Db,
  queueId: string,
  actorUserId: string,
): Promise<boolean> {
  const [membership] = await db
    .select({ membershipId: schema.queueMembers.membershipId })
    .from(schema.queueMembers)
    .where(
      and(
        eq(schema.queueMembers.queueId, queueId),
        eq(schema.queueMembers.userId, actorUserId),
        eq(schema.queueMembers.isActive, true),
      ),
    )
    .limit(1);
  if (membership) return true;
  const [tagged] = await db
    .select({ userId: schema.users.userId })
    .from(schema.users)
    .innerJoin(
      schema.specialistQueues,
      eq(schema.specialistQueues.queueId, queueId),
    )
    .where(
      and(
        eq(schema.users.userId, actorUserId),
        eq(schema.users.status, "active"),
        sql`${schema.users.tags} ? ${schema.specialistQueues.key}`,
      ),
    )
    .limit(1);
  return Boolean(tagged);
}

async function canClaim(
  db: Db,
  state: typeof schema.handoffStates.$inferSelect,
  actorUserId: string,
) {
  if (state.status === "transfer_pending")
    return state.targetUserId === actorUserId;
  if (state.status !== "pending" || state.assignedUserId) return false;
  if (
    !state.assignedQueueId ||
    state.assignedQueueId === GENERAL_HANDOFF_QUEUE_ID
  )
    return true;
  return actorMatchesQueue(db, state.assignedQueueId, actorUserId);
}

async function presentState(
  db: Db,
  state: typeof schema.handoffStates.$inferSelect,
  actorUserId: string,
): Promise<MobileHandoffState> {
  const [owner] = state.assignedUserId
    ? await db
        .select({ username: schema.users.username })
        .from(schema.users)
        .where(eq(schema.users.userId, state.assignedUserId))
        .limit(1)
    : [];
  const [targetUser] = state.targetUserId
    ? await db
        .select({ username: schema.users.username })
        .from(schema.users)
        .where(eq(schema.users.userId, state.targetUserId))
        .limit(1)
    : [];
  const queueId = state.targetQueueId ?? state.assignedQueueId;
  const [queue] = queueId
    ? await db
        .select({ displayName: schema.specialistQueues.displayName })
        .from(schema.specialistQueues)
        .where(eq(schema.specialistQueues.queueId, queueId))
        .limit(1)
    : [];
  return {
    ...snapshotState(state),
    ownerDisplayName: owner?.username ?? null,
    targetDisplayName: targetUser?.username ?? queue?.displayName ?? null,
    canClaim: await canClaim(db, state, actorUserId),
    canRejectTransfer:
      state.status === "transfer_pending" && state.targetUserId === actorUserId,
  };
}

function presentCycle(cycle: typeof schema.handoffCycles.$inferSelect) {
  return {
    ...cycle,
    status: canonicalStatus(cycle.status),
    createdAt: cycle.createdAt.toISOString(),
    acceptedAt: cycle.acceptedAt?.toISOString() ?? null,
    resolvedAt: cycle.resolvedAt?.toISOString() ?? null,
    finishedAt: cycle.finishedAt?.toISOString() ?? null,
    updatedAt: cycle.updatedAt.toISOString(),
  };
}

function snapshotState(
  state: typeof schema.handoffStates.$inferSelect,
): Omit<
  MobileHandoffState,
  "ownerDisplayName" | "targetDisplayName" | "canClaim" | "canRejectTransfer"
> {
  return {
    conversationId: state.conversationId,
    cycleId: state.cycleId,
    handoffRevision: state.handoffRevision,
    status: canonicalStatus(state.status),
    assignedUserId: state.assignedUserId,
    assignedQueueId: state.assignedQueueId,
    targetUserId: state.targetUserId,
    targetQueueId: state.targetQueueId,
    createdAt: state.createdAt.toISOString(),
    acceptedAt: state.acceptedAt?.toISOString() ?? null,
    transferredAt: state.transferredAt?.toISOString() ?? null,
    pendingSince: state.pendingSince?.toISOString() ?? null,
    acceptBy: state.acceptBy?.toISOString() ?? null,
    fallbackQueueId: state.fallbackQueueId,
    finishedAt: state.finishedAt?.toISOString() ?? null,
    resolvedAt: state.resolvedAt?.toISOString() ?? null,
  };
}

function canonicalStatus(status: string): MobileHandoffState["status"] {
  if (status === "pending") return "HANDOFF_PENDING";
  if (status === "transfer_pending") return "TRANSFER_PENDING";
  if (status === "in_progress") return "HUMAN_ACTIVE";
  return "HUMAN_FINISHED";
}

function isoValue(value: Date | string | null) {
  if (!value) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

async function replayOperation(
  transaction: Transaction,
  operation: MobileOperation,
  input: { clientRequestId: string; actorUserId: string },
): Promise<MobileWriteResult | undefined> {
  const [event] = await transaction
    .select()
    .from(schema.handoffEvents)
    .where(eq(schema.handoffEvents.clientRequestId, input.clientRequestId))
    .limit(1);
  if (!event) return undefined;
  if (
    event.actorUserId !== input.actorUserId ||
    event.eventType !== eventTypeFor(operation) ||
    event.requestHash !== requestHash(input)
  )
    return { status: "idempotency_conflict" };
  return {
    status: "ok",
    replayed: true,
    handoff: event.responseSnapshot as unknown as MobileHandoffState,
  };
}

async function recordOperation(
  transaction: Transaction,
  value: {
    operation: MobileOperation;
    input: {
      conversationId: string;
      actorUserId: string;
      clientRequestId: string;
      sourceIp: string;
    };
    state: typeof schema.handoffStates.$inferSelect;
    eventType: string;
    fromStatus: string;
    summary: string;
  },
) {
  const snapshot = snapshotState(value.state);
  const eventId = eventIdFor(value.input.clientRequestId);
  await transaction.insert(schema.handoffEvents).values({
    eventId,
    cycleId: value.state.cycleId,
    conversationId: value.input.conversationId,
    actorUserId: value.input.actorUserId,
    targetUserId: value.state.targetUserId,
    eventType: value.eventType,
    fromStatus: value.fromStatus,
    toStatus: value.state.status,
    clientRequestId: value.input.clientRequestId,
    requestHash: requestHash(value.input),
    responseSnapshot: snapshot,
    outcomeStatus: "succeeded",
    summary: value.summary,
  });
  await transaction.insert(schema.auditEvents).values({
    auditId: randomUUID(),
    actorUserId:
      value.input.actorUserId === "system" ? null : value.input.actorUserId,
    eventType: `handoff.${value.eventType}`,
    subjectType: "handoff_event",
    subjectId: eventId,
    sourceIp: value.input.sourceIp,
    metadata: {
      conversationId: value.input.conversationId,
      cycleId: value.state.cycleId,
      clientRequestId: value.input.clientRequestId,
      operation: value.operation,
    },
  });
}

function eventTypeFor(operation: MobileOperation) {
  if (operation === "claim_handoff") return "claimed";
  if (operation === "transfer_handoff") return "transfer_requested";
  if (operation === "reject_transfer") return "transfer_rejected";
  if (operation === "take_over") return "manual_taken_over";
  return "finished";
}

function requestHash(value: unknown) {
  const normalized = JSON.stringify(value, Object.keys(value as object).sort());
  return createHash("sha256").update(normalized).digest("hex");
}

function eventIdFor(clientRequestId: string) {
  return `handoff-event:${createHash("sha256").update(clientRequestId).digest("hex")}`;
}

function cycleIdFor(clientRequestId: string, suffix: string) {
  return `handoff-cycle:${createHash("sha256").update(`${suffix}:${clientRequestId}`).digest("hex")}`;
}

function resolutionSummaryText(
  cycle: typeof schema.handoffCycles.$inferSelect,
  latestHumanReply?: string,
) {
  const problem = cycle.briefing?.problemSummary.trim();
  const fact = cycle.briefing?.confirmedFacts[0];
  const action = latestHumanReply?.trim()
    ? `人工已回复：${latestHumanReply.trim().slice(0, 500)}`
    : fact
      ? `已确认${fact.label}为${fact.value}`
      : "已完成人工处理";
  const outcome =
    cycle.result === "customer_no_response"
      ? "，等待客户后续反馈。"
      : cycle.result === "information_collected"
        ? "，已补充处理所需信息。"
        : "，后续消息由 Agent 继续处理。";
  return `${problem ? `${problem}；` : ""}${action}${outcome}`.slice(0, 1_000);
}

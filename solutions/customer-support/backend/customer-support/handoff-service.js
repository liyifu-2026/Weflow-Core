/**
 * Customer Support handoff domain service.
 *
 * This is a plugin-local implementation of the handoff state transitions.
 * It no longer relies on Core-injected handoff services.
 */

export function createHandoffService(ctx) {
  const { db, schema, eq, and, isNull } = ctx;

  async function findState(conversationId) {
    const rows = await db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function suppressHandoffForConversation(conversationId) {
    await db
      .update(schema.agentTurns)
      .set({
        status: "cancelled",
        errorCode: "handoff_active",
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.agentTurns.conversationId, conversationId),
          eq(schema.agentTurns.status, "queued"),
        ),
      );
  }

  async function insertHandoffConfirmation(conversationId) {
    const messageId = `handoff-message:${crypto.randomUUID()}`;
    await db.insert(schema.messages).values({
      messageId,
      conversationId,
      channelEventId: null,
      channelMessageId: null,
      direction: "outbound",
      actorType: "system",
      actorId: "system-agent",
      contentType: "text",
      channelType: 1,
      text: "已收到您的情况，已转交专人跟进。",
      isSelf: true,
      processingState: "not_applicable",
      sendState: "pending",
      idempotencyKey: messageId,
      occurredAt: new Date(),
      traceId: `handoff:${messageId}`,
    }).onConflictDoNothing();
  }

  async function enqueueNotification(input, kind, payload) {
    if (!input.targetUserId && !input.assignedUserId) return;
    const userId = input.targetUserId ?? input.assignedUserId;
    await db.insert(schema.notificationOutbox).values({
      notificationId: `notify:${crypto.randomUUID()}`,
      userId,
      conversationId: input.conversationId,
      kind,
      dedupeKey: `${kind}:${input.conversationId}:${userId}`,
      payload,
      status: "pending",
    }).onConflictDoNothing();
  }

  async function insertEvent(input, current, nextStatus, handoff, type) {
    const eventId = `handoff-event:${crypto.randomUUID()}`;
    await db.insert(schema.handoffEvents).values({
      eventId,
      cycleId: handoff.cycleId,
      conversationId: input.conversationId,
      actorUserId: input.actorUserId,
      eventType: type,
      fromStatus: current?.status ?? null,
      toStatus: nextStatus,
      clientRequestId: input.clientRequestId,
      summary: input.summary ?? "",
      outcomeStatus: "succeeded",
      responseSnapshot: { handoff },
    });
    await db.insert(schema.auditEvents).values({
      auditId: crypto.randomUUID(),
      actorUserId: input.actorUserId,
      eventType: `handoff.${type}`,
      subjectType: "handoff_event",
      subjectId: eventId,
      sourceIp: input.sourceIp,
      metadata: {
        handoffEventId: eventId,
        clientRequestId: input.clientRequestId,
      },
    });
  }

  async function accept(input) {
    const current = await findState(input.conversationId);
    if (!current || current.status !== "pending" || current.assignedUserId) {
      return { status: "invalid_transition" };
    }
    const now = new Date();
    const [updated] = await db
      .update(schema.handoffStates)
      .set({
        status: "in_progress",
        assignedUserId: input.actorUserId,
        assignedQueueId: null,
        acceptedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.handoffStates.conversationId, input.conversationId),
          eq(schema.handoffStates.status, "pending"),
          isNull(schema.handoffStates.assignedUserId),
        ),
      )
      .returning();
    if (!updated) return { status: "invalid_transition" };
    await db
      .update(schema.handoffCycles)
      .set({ status: "in_progress", assignedUserId: input.actorUserId, acceptedAt: now, updatedAt: now })
      .where(eq(schema.handoffCycles.cycleId, current.cycleId));
    await insertEvent(input, current, "in_progress", updated, "accepted");
    return { status: "ok", handoff: updated };
  }

  async function takeOver(input) {
    const current = await findState(input.conversationId);
    if (!current || current.agentPaused) {
      return { status: "invalid_transition" };
    }
    const now = new Date();
    const cycleId = current?.cycleId ?? `handoff-cycle:${crypto.randomUUID()}`;
    const [updated] = await db
      .insert(schema.handoffStates)
      .values({
        conversationId: input.conversationId,
        cycleId,
        status: "in_progress",
        contractVersion: 2,
        handoffRevision: (current?.handoffRevision ?? 0) + 1,
        reason: input.summary ?? "",
        assignedUserId: input.actorUserId,
        assignedQueueId: null,
        createdByUserId: input.actorUserId,
        agentPaused: true,
        createdAt: now,
        acceptedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.handoffStates.conversationId,
        set: {
          status: "in_progress",
          assignedUserId: input.actorUserId,
          assignedQueueId: null,
          acceptedAt: now,
          updatedAt: now,
          agentPaused: true,
        },
      })
      .returning();
    await suppressHandoffForConversation(input.conversationId);
    await insertHandoffConfirmation(input.conversationId);
    await insertEvent(input, current, "in_progress", updated, "manual_taken_over");
    return { status: "ok", handoff: updated };
  }

  async function transfer(input) {
    const current = await findState(input.conversationId);
    if (
      !current ||
      current.status !== "in_progress" ||
      current.assignedUserId !== input.actorUserId
    ) {
      return { status: "invalid_transition" };
    }
    if (!input.targetUserId || input.targetUserId === input.actorUserId) {
      return { status: "invalid_transition" };
    }
    const now = new Date();
    const [updated] = await db
      .update(schema.handoffStates)
      .set({
        assignedUserId: input.targetUserId,
        reason: input.summary ?? current.reason,
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
    if (!updated) return { status: "invalid_transition" };
    await db
      .update(schema.handoffCycles)
      .set({ assignedUserId: input.targetUserId, updatedAt: now })
      .where(eq(schema.handoffCycles.cycleId, current.cycleId));
    await enqueueNotification(
      { ...input, targetUserId: input.targetUserId },
      "handoff_transferred",
      { conversationId: input.conversationId },
    );
    await insertEvent(input, current, "in_progress", updated, "transferred");
    return { status: "ok", handoff: updated };
  }

  async function resolve(input) {
    const current = await findState(input.conversationId);
    if (
      !current ||
      current.status !== "in_progress" ||
      current.assignedUserId !== input.actorUserId
    ) {
      return { status: "invalid_transition" };
    }
    const now = new Date();
    const [updated] = await db
      .update(schema.handoffStates)
      .set({
        status: "resolved",
        assignedQueueId: null,
        resolvedByUserId: input.actorUserId,
        resolution: input.summary,
        agentPaused: false,
        resolvedAt: now,
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
    if (!updated) return { status: "invalid_transition" };
    await db
      .update(schema.handoffCycles)
      .set({ status: "resolved", resolvedByUserId: input.actorUserId, resolvedAt: now, updatedAt: now })
      .where(eq(schema.handoffCycles.cycleId, current.cycleId));
    await insertEvent(input, current, "resolved", updated, "resolved");
    return { status: "ok", handoff: updated };
  }

  return { accept, takeOver, transfer, resolve };
}

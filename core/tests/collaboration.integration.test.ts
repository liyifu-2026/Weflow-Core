import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { createCollaborationRequest } from "../modules/collaboration/application/collaboration-service.js";
import { escalateHandoff } from "../modules/handoff/application/handoff-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("collaboration transfer", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const actorUserId = `actor-${suffix}`.slice(0, 36);
  const contactId = `contact:channel:collaboration-${suffix}`;
  const conversationId = `channel:collaboration-${suffix}`;
  const cycleId = `cycle-${suffix}`;
  const queueId = `queue-${suffix}`.slice(0, 36);

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "collaboration-test"),
    );
    await postgres.db.insert(schema.users).values({
      userId: actorUserId,
      username: `collab-${suffix}`.slice(0, 64),
      passwordHash: "not-used-by-this-test",
      mustChangePassword: false,
      status: "active",
    });
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `collaboration-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `collaboration-${suffix}`,
    });
    await postgres.db.insert(schema.handoffCycles).values({
      cycleId,
      conversationId,
      status: "in_progress",
      reason: "test",
      assignedUserId: actorUserId,
      createdByUserId: actorUserId,
    });
    await postgres.db.insert(schema.handoffStates).values({
      conversationId,
      cycleId,
      status: "in_progress",
      reason: "test",
      assignedUserId: actorUserId,
      createdByUserId: actorUserId,
      agentPaused: true,
    });
    await postgres.db.insert(schema.specialistQueues).values({
      queueId,
      key: `test-${suffix}`.slice(0, 80),
      displayName: "测试专业队列",
    });
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.actorUserId, actorUserId));
    await postgres.db
      .delete(schema.collaborationRequestParticipants)
      .where(eq(schema.collaborationRequestParticipants.userId, actorUserId));
    await postgres.db
      .delete(schema.collaborationRequests)
      .where(eq(schema.collaborationRequests.conversationId, conversationId));
    await postgres.db
      .delete(schema.handoffEvents)
      .where(eq(schema.handoffEvents.conversationId, conversationId));
    await postgres.db
      .delete(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId));
    await postgres.db
      .delete(schema.handoffCycles)
      .where(eq(schema.handoffCycles.conversationId, conversationId));
    await postgres.db
      .delete(schema.specialistQueues)
      .where(eq(schema.specialistQueues.queueId, queueId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, contactId));
    await postgres.db
      .delete(schema.users)
      .where(eq(schema.users.userId, actorUserId));
    await postgres.close();
  });

  it("rolls back a handoff escalation with the caller transaction", async () => {
    await expect(
      postgres.db.transaction(async (transaction) => {
        const result = await escalateHandoff(transaction, {
          conversationId,
          handoffId: cycleId,
          actorUserId,
          queueId,
          reason: "事务回滚测试",
          expectedHandoffRevision: 1,
          clientRequestId: crypto.randomUUID(),
        });
        expect(result.status).toBe("ok");
        throw new Error("rollback_handoff_escalation");
      }),
    ).rejects.toThrow("rollback_handoff_escalation");

    const [state] = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId));
    expect(state).toMatchObject({
      status: "in_progress",
      handoffRevision: 1,
      assignedUserId: actorUserId,
    });
  });

  it("moves an owned handoff to a specialist queue without exceeding event identifiers", async () => {
    const clientRequestId = crypto.randomUUID();
    const input = {
      conversationId,
      handoffId: cycleId,
      actorUserId,
      kind: "escalation" as const,
      queueId,
      reason: "需要专业人员继续处理",
      clientRequestId,
      sourceIp: "127.0.0.1",
    };
    const result = await createCollaborationRequest(postgres.db, input);

    expect(result).toMatchObject({ status: "ok", replayed: false });
    const [state] = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId));
    expect(state).toMatchObject({
      status: "pending",
      handoffRevision: 1,
      assignedUserId: null,
      assignedQueueId: queueId,
    });
    const [cycle] = await postgres.db
      .select()
      .from(schema.handoffCycles)
      .where(eq(schema.handoffCycles.cycleId, cycleId));
    expect(cycle).toMatchObject({
      status: "pending",
      handoffRevision: 1,
      assignedUserId: null,
      assignedQueueId: queueId,
    });
    const events = await postgres.db
      .select()
      .from(schema.handoffEvents)
      .where(eq(schema.handoffEvents.conversationId, conversationId));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventId.length).toBeLessThanOrEqual(100);
    expect(events[0]).toMatchObject({
      eventType: "escalated",
      fromStatus: "in_progress",
      toStatus: "pending",
      clientRequestId,
    });

    const replay = await createCollaborationRequest(postgres.db, input);
    expect(replay).toMatchObject({ status: "ok", replayed: true });
    const replayEvents = await postgres.db
      .select({ eventId: schema.handoffEvents.eventId })
      .from(schema.handoffEvents)
      .where(eq(schema.handoffEvents.conversationId, conversationId));
    expect(replayEvents).toHaveLength(1);

    const stale = await postgres.db.transaction((transaction) =>
      escalateHandoff(transaction, {
        conversationId,
        handoffId: cycleId,
        actorUserId,
        queueId,
        reason: "旧 revision",
        expectedHandoffRevision: 0,
        clientRequestId: crypto.randomUUID(),
      }),
    );
    expect(stale).toEqual({ status: "revision_conflict" });

    const wrongOwner = await postgres.db.transaction((transaction) =>
      escalateHandoff(transaction, {
        conversationId,
        handoffId: cycleId,
        actorUserId: "another-actor",
        queueId,
        reason: "错误 owner",
        expectedHandoffRevision: 1,
        clientRequestId: crypto.randomUUID(),
      }),
    );
    expect(wrongOwner).toEqual({ status: "not_assignee" });

    const illegalTransition = await postgres.db.transaction((transaction) =>
      escalateHandoff(transaction, {
        conversationId,
        handoffId: cycleId,
        actorUserId,
        queueId,
        reason: "重复升级",
        expectedHandoffRevision: 1,
        clientRequestId: crypto.randomUUID(),
      }),
    );
    expect(illegalTransition).toEqual({ status: "not_assignee" });
  });
});

import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { processAgentTurn } from "../modules/agent/application/process-agent-turn.js";
import { registerConversationRoutes } from "../modules/conversations/interface/http-routes.js";
import { registerContactProfileRoutes } from "../modules/contacts/interface/http-routes.js";
import { registerHandoffRoutes } from "../modules/handoff/interface/http-routes.js";
import { createClosedUser } from "../modules/identity/application/identity-service.js";
import { registerIdentityRoutes } from "../modules/identity/interface/http-routes.js";
import { registerMemoryRoutes } from "../modules/memory/interface/http-routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationDatabaseUrl = databaseUrl ?? "";
const integration = databaseUrl ? describe : describe.skip;

integration("shared conversation query", () => {
  let postgres: Postgres;
  const server = Fastify();
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const usernames = [`shared-a-${suffix}`, `shared-b-${suffix}`];
  const userIds: string[] = [];
  const initialPassword = "Initial-shared-password-1!";
  const newPassword = "Replacement-shared-password-2!";
  const conversationId = `channel:shared-${suffix}`;
  const contactId = `contact:channel:shared-${suffix}`;
  const firstMessageId = `channel:shared-${suffix}-1`;
  const secondMessageId = `channel:shared-${suffix}-2`;

  beforeAll(async () => {
    postgres = createPostgres(
      integrationDatabaseUrl,
      createLogger({ logLevel: "silent" }, "conversation-query-test"),
    );
    for (const username of usernames) {
      const user = await createClosedUser(
        postgres.db,
        username,
        initialPassword,
      );
      userIds.push(user.userId);
    }
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `shared-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `shared-${suffix}`,
    });
    await postgres.db.insert(schema.messages).values([
      {
        messageId: firstMessageId,
        conversationId,
        direction: "inbound",
        actorType: "channel_contact",
        actorId: "contact-1",
        contentType: "text",
        channelType: 1,
        text: "first shared message",
        processingState: "received",
        idempotencyKey: firstMessageId,
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
        traceId: firstMessageId,
      },
      {
        messageId: secondMessageId,
        conversationId,
        direction: "outbound",
        actorType: "agent",
        actorId: "agent-worker",
        contentType: "text",
        channelType: 1,
        text: "second shared message",
        processingState: "not_applicable",
        sendState: "confirmed",
        idempotencyKey: secondMessageId,
        occurredAt: new Date("2026-01-01T00:01:00.000Z"),
        traceId: secondMessageId,
      },
    ]);
    registerIdentityRoutes(server, postgres.db);
    registerConversationRoutes(server, postgres.db);
    registerContactProfileRoutes(server, postgres.db);
    registerHandoffRoutes(server, postgres.db);
    registerMemoryRoutes(server, postgres.db);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
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
      .delete(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    const memories = await postgres.db
      .select({ memoryId: schema.memories.memoryId })
      .from(schema.memories)
      .where(eq(schema.memories.contactId, contactId));
    for (const memory of memories) {
      await postgres.db
        .delete(schema.memoryEvents)
        .where(eq(schema.memoryEvents.memoryId, memory.memoryId));
    }
    await postgres.db
      .delete(schema.memories)
      .where(eq(schema.memories.contactId, contactId));
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(eq(schema.memoryCaptureStates.conversationId, conversationId));
    await postgres.db
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    await postgres.db
      .delete(schema.contactAliasEvents)
      .where(eq(schema.contactAliasEvents.contactId, contactId));
    await postgres.db
      .delete(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.conversationId, conversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(inArray(schema.conversations.conversationId, [conversationId]));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, contactId));
    await postgres.db
      .delete(schema.auditEvents)
      .where(inArray(schema.auditEvents.actorUserId, userIds));
    await postgres.db
      .delete(schema.auditEvents)
      .where(inArray(schema.auditEvents.subjectId, [...userIds, ...usernames]));
    await postgres.db
      .delete(schema.userSessions)
      .where(inArray(schema.userSessions.userId, userIds));
    await postgres.db
      .delete(schema.users)
      .where(inArray(schema.users.userId, userIds));
    await postgres.close();
  });

  it("blocks initial passwords and exposes one shared transcript to both users", async () => {
    const cookies: string[] = [];
    for (const username of usernames) {
      const login = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username, password: initialPassword },
      });
      const setCookie = login.headers["set-cookie"];
      const cookie =
        typeof setCookie === "string" ? setCookie.split(";")[0] : undefined;
      if (!cookie) throw new Error("missing session cookie");

      const blocked = await server.inject({
        method: "GET",
        url: "/api/v1/conversations",
        headers: { cookie },
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toEqual({ error: "password_change_required" });

      const changed = await server.inject({
        method: "POST",
        url: "/api/v1/auth/change-password",
        headers: { cookie },
        payload: {
          currentPassword: initialPassword,
          newPassword,
        },
      });
      expect(changed.statusCode).toBe(200);
      cookies.push(cookie);
    }

    const results = [];
    for (const cookie of cookies) {
      const list = await server.inject({
        method: "GET",
        url: "/api/v1/conversations",
        headers: { cookie },
      });
      expect(list.statusCode).toBe(200);
      const matching = list
        .json<{
          conversations: Array<{
            conversationId: string;
            latestMessageAt: string;
            latestMessage: { text: string; actorType: string };
            contact: {
              contactId: string;
              channelContactId: string;
              tags: string[];
            };
            riskLevel: string | null;
          }>;
        }>()
        .conversations.filter(
          (conversation) => conversation.conversationId === conversationId,
        );
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({
        conversationId,
        latestMessage: {
          text: "second shared message",
          actorType: "agent",
        },
        contact: {
          contactId,
          channelContactId: `shared-${suffix}`,
          tags: [],
        },
        riskLevel: null,
      });

      const firstPage = await server.inject({
        method: "GET",
        url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=1`,
        headers: { cookie },
      });
      expect(firstPage.statusCode).toBe(200);
      const firstBody = firstPage.json<{
        messages: { messageId: string; text: string }[];
        nextCursor: string;
      }>();
      expect(firstBody.messages).toEqual([
        expect.objectContaining({
          messageId: secondMessageId,
          text: "second shared message",
        }),
      ]);

      const secondPage = await server.inject({
        method: "GET",
        url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=1&before=${encodeURIComponent(firstBody.nextCursor)}`,
        headers: { cookie },
      });
      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json()).toMatchObject({
        messages: [
          {
            messageId: firstMessageId,
            text: "first shared message",
          },
        ],
        nextCursor: null,
      });
      results.push({ list: matching, transcript: firstBody.messages });
    }
    expect(results[0]).toEqual(results[1]);

    const deniedReply = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      headers: { cookie: cookies[0] },
      payload: {
        text: "manual reply from shared workspace",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32263",
      },
    });
    expect(deniedReply.statusCode).toBe(403);
    expect(deniedReply.json()).toEqual({ error: "handoff_not_assignee" });

    await postgres.db.insert(schema.agentTurns).values({
      turnId: `handoff-test-turn:${suffix}`,
      triggerMessageId: firstMessageId,
      conversationId,
      status: "queued",
      traceId: `handoff-test:${suffix}`,
    });

    const createdHandoff = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff`,
      headers: { cookie: cookies[0] },
      payload: {
        summary: "needs a human decision",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32264",
      },
    });
    expect(createdHandoff.statusCode).toBe(201);
    expect(createdHandoff.json()).toMatchObject({
      handoff: { status: "pending", agentPaused: true },
      replayed: false,
    });

    const suppressedTurns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    expect(suppressedTurns[0]).toMatchObject({
      status: "suppressed_handoff",
      errorCode: "handoff_active",
    });

    const lateTurnId = `handoff-late-turn:${suffix}`;
    await postgres.db.insert(schema.agentTurns).values({
      turnId: lateTurnId,
      triggerMessageId: secondMessageId,
      conversationId,
      status: "queued",
      traceId: `handoff-late:${suffix}`,
    });
    let modelCalls = 0;
    const model = new OpenAiCompatibleClient({
      baseUrl: "https://model.invalid",
      apiKey: "test-only",
      model: "deepseek-v4-flash",
      timeoutMs: 1_000,
      fetch: () => {
        modelCalls += 1;
        return Promise.resolve(Response.json({ choices: [] }));
      },
    });
    await processAgentTurn(postgres.db, model, "deepseek-v4-flash", {
      turnId: lateTurnId,
      traceId: `handoff-late:${suffix}`,
    });
    expect(modelCalls).toBe(0);

    const acceptedHandoff = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/accept`,
      headers: { cookie: cookies[1] },
      payload: {
        summary: "second user accepted",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32265",
      },
    });
    expect(acceptedHandoff.statusCode).toBe(201);
    expect(acceptedHandoff.json()).toMatchObject({
      handoff: {
        status: "in_progress",
        agentPaused: true,
        assignedUserId: userIds[1],
      },
    });

    const rejectedClaim = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/accept`,
      headers: { cookie: cookies[0] },
      payload: {
        summary: "first user lost the claim race",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32270",
      },
    });
    expect(rejectedClaim.statusCode).toBe(409);
    expect(rejectedClaim.json()).toMatchObject({
      error: "handoff_already_claimed",
      handoff: { assignedUserId: userIds[1], status: "in_progress" },
      assignee: { userId: userIds[1], username: usernames[1] },
    });

    const clientRequestId = "018f47a6-7b9c-7c41-8a36-8e885bd32267";
    const firstReply = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      headers: { cookie: cookies[1] },
      payload: { text: "manual reply from assigned user", clientRequestId },
    });
    expect(firstReply.statusCode).toBe(202);
    const firstReplyBody = firstReply.json<{
      message: { messageId: string };
      replayed: boolean;
    }>();
    expect(firstReplyBody).toMatchObject({
      message: {
        actorType: "user",
        actorId: userIds[1],
        direction: "outbound",
        sendState: "pending",
        text: "manual reply from assigned user",
      },
      replayed: false,
    });

    const replay = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      headers: { cookie: cookies[1] },
      payload: { text: "manual reply from assigned user", clientRequestId },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({
      message: { messageId: firstReplyBody.message.messageId },
      replayed: true,
    });

    const nonAssigneeReply = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      headers: { cookie: cookies[0] },
      payload: {
        text: "manual reply from non-assignee",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32268",
      },
    });
    expect(nonAssigneeReply.statusCode).toBe(403);
    expect(nonAssigneeReply.json()).toEqual({ error: "handoff_not_assignee" });

    const releasedHandoff = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/release`,
      headers: { cookie: cookies[1] },
      payload: {
        summary: "assigned user returned the work",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32271",
      },
    });
    expect(releasedHandoff.statusCode).toBe(201);
    expect(releasedHandoff.json()).toMatchObject({
      handoff: {
        status: "pending",
        assignedUserId: null,
        agentPaused: true,
      },
    });

    const reclaimedHandoff = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/accept`,
      headers: { cookie: cookies[1] },
      payload: {
        summary: "assigned user reclaimed the work",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32272",
      },
    });
    expect(reclaimedHandoff.statusCode).toBe(201);
    expect(reclaimedHandoff.json()).toMatchObject({
      handoff: { status: "in_progress", assignedUserId: userIds[1] },
    });

    const sharedHandoffs = [];
    for (const cookie of cookies) {
      const handoff = await server.inject({
        method: "GET",
        url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff`,
        headers: { cookie },
      });
      expect(handoff.statusCode).toBe(200);
      sharedHandoffs.push(handoff.json());
    }
    expect(sharedHandoffs[0]).toEqual(sharedHandoffs[1]);

    const nonAssigneeResolve = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/resolve`,
      headers: { cookie: cookies[0] },
      payload: {
        summary: "attempted by a non-assignee",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32269",
      },
    });
    expect(nonAssigneeResolve.statusCode).toBe(403);
    expect(nonAssigneeResolve.json()).toEqual({
      error: "handoff_not_assignee",
    });

    const resolvedHandoff = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/resolve`,
      headers: { cookie: cookies[1] },
      payload: {
        summary: "handled and Agent may resume",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32266",
      },
    });
    expect(resolvedHandoff.statusCode).toBe(201);
    expect(resolvedHandoff.json()).toMatchObject({
      handoff: {
        status: "resolved",
        agentPaused: false,
        resolvedByUserId: userIds[1],
      },
    });

    const manualTakeOver = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/take-over`,
      headers: { cookie: cookies[0] },
      payload: {
        summary: "客服主动接手后续咨询",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32273",
      },
    });
    expect(manualTakeOver.statusCode).toBe(201);
    expect(manualTakeOver.json()).toMatchObject({
      handoff: {
        status: "in_progress",
        assignedUserId: userIds[0],
        agentPaused: true,
      },
    });
    const rejectedManualTakeOver = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/take-over`,
      headers: { cookie: cookies[1] },
      payload: {
        summary: "second user lost the manual claim race",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32274",
      },
    });
    expect(rejectedManualTakeOver.statusCode).toBe(409);
    expect(rejectedManualTakeOver.json()).toMatchObject({
      error: "handoff_already_claimed",
      handoff: { status: "in_progress", assignedUserId: userIds[0] },
      assignee: { userId: userIds[0], username: usernames[0] },
    });
    const assignees = await server.inject({
      method: "GET",
      url: "/api/v1/handoff-assignees",
      headers: { cookie: cookies[0] },
    });
    expect(assignees.statusCode).toBe(200);
    expect(
      assignees.json<{ users: Array<{ userId: string }> }>().users,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: userIds[1] })]),
    );
    const transferred = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/transfer`,
      headers: { cookie: cookies[0] },
      payload: {
        targetUserId: userIds[1],
        summary: "转给同事继续处理",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32275",
      },
    });
    expect(transferred.statusCode).toBe(201);
    expect(transferred.json()).toMatchObject({
      handoff: { status: "in_progress", assignedUserId: userIds[1] },
    });
    const replayedTransfer = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/transfer`,
      headers: { cookie: cookies[0] },
      payload: {
        targetUserId: userIds[1],
        summary: "转给同事继续处理",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32275",
      },
    });
    expect(replayedTransfer.statusCode).toBe(200);
    expect(replayedTransfer.json()).toMatchObject({
      replayed: true,
      handoff: { status: "in_progress", assignedUserId: userIds[1] },
    });
    const transferNotifications = await postgres.db
      .select()
      .from(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.conversationId, conversationId));
    expect(transferNotifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: userIds[1],
          kind: "handoff_assigned",
        }),
      ]),
    );
    const handoffHistory = await server.inject({
      method: "GET",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff`,
      headers: { cookie: cookies[0] },
    });
    expect(handoffHistory.statusCode).toBe(200);
    const handoffHistoryBody = handoffHistory.json<{
      handoff: {
        cycles: Array<{ status: string; assignedUserId: string | null }>;
      };
    }>();
    expect(handoffHistoryBody.handoff.cycles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "HUMAN_FINISHED" }),
        expect.objectContaining({
          status: "HUMAN_ACTIVE",
          assignedUserId: userIds[1],
        }),
      ]),
    );

    const handoffAudits = await postgres.db
      .select()
      .from(schema.auditEvents)
      .where(inArray(schema.auditEvents.actorUserId, userIds));
    expect(handoffAudits.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "handoff.created",
        "handoff.accepted",
        "handoff.released",
        "handoff.resolved",
        "handoff.manual_taken_over",
        "handoff.transferred",
      ]),
    );

    const profileBefore = await server.inject({
      method: "GET",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/contact-profile`,
      headers: { cookie: cookies[0] },
    });
    expect(profileBefore.statusCode).toBe(200);
    expect(profileBefore.json()).toMatchObject({
      profile: {
        contactId,
        agentEnabled: true,
        tags: [],
      },
    });

    const policyMessageId = `contact-policy-message:${suffix}`;
    const policyTurnId = `contact-policy-turn:${suffix}`;
    await postgres.db.insert(schema.messages).values({
      messageId: policyMessageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      actorId: "contact-1",
      contentType: "text",
      channelType: 1,
      text: "should be suppressed by contact policy",
      processingState: "received",
      idempotencyKey: policyMessageId,
      occurredAt: new Date(),
      traceId: policyMessageId,
    });
    await postgres.db.insert(schema.agentTurns).values({
      turnId: policyTurnId,
      triggerMessageId: policyMessageId,
      conversationId,
      status: "queued",
      traceId: policyTurnId,
    });

    const disabled = await server.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/contact-profile`,
      headers: { cookie: cookies[1] },
      payload: {
        sharedAlias: "深圳陈先生｜V9 经销商",
        note: "do not auto reply",
        tags: ["manual-only", "manual-only"],
        agentEnabled: false,
      },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      profile: {
        sharedAlias: "深圳陈先生｜V9 经销商",
        note: "do not auto reply",
        tags: ["manual-only"],
        agentEnabled: false,
        updatedByUserId: userIds[1],
      },
    });

    const policyTurns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, policyTurnId));
    expect(policyTurns[0]).toMatchObject({
      status: "suppressed_policy",
      errorCode: "agent_disabled",
    });
    const profileAudits = await postgres.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, contactId));
    expect(profileAudits).toHaveLength(1);
    expect(profileAudits[0]).toMatchObject({
      actorUserId: userIds[1],
      eventType: "contact_profile.updated",
    });
    const aliasEvents = await postgres.db
      .select()
      .from(schema.contactAliasEvents)
      .where(eq(schema.contactAliasEvents.contactId, contactId));
    expect(aliasEvents).toHaveLength(1);
    expect(aliasEvents[0]).toMatchObject({
      actorUserId: userIds[1],
      previousAlias: null,
      nextAlias: "深圳陈先生｜V9 经销商",
    });

    const createMemoryRequestId = "018f47a6-7b9c-7c41-8a36-8e885bd32267";
    const createdMemory = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/memories`,
      headers: { cookie: cookies[0] },
      payload: {
        kind: "preference",
        key: "language",
        content: "中文",
        clientRequestId: createMemoryRequestId,
      },
    });
    expect(createdMemory.statusCode).toBe(201);
    const createdMemoryBody = createdMemory.json<{
      memory: { memoryId: string; status: string };
      replayed: boolean;
    }>();
    expect(createdMemoryBody).toMatchObject({
      memory: { status: "active" },
      replayed: false,
    });
    const replayedMemory = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/memories`,
      headers: { cookie: cookies[0] },
      payload: {
        kind: "preference",
        key: "language",
        content: "中文",
        clientRequestId: createMemoryRequestId,
      },
    });
    expect(replayedMemory.statusCode).toBe(200);
    expect(replayedMemory.json()).toMatchObject({ replayed: true });

    const invalidatedMemory = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/memories/${createdMemoryBody.memory.memoryId}/actions`,
      headers: { cookie: cookies[1] },
      payload: {
        action: "invalidate",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32268",
      },
    });
    expect(invalidatedMemory.statusCode).toBe(200);
    expect(invalidatedMemory.json()).toMatchObject({
      memory: { status: "invalidated" },
      replayed: false,
    });

    const candidateMemoryId = `candidate-memory:${suffix}`;
    await postgres.db.insert(schema.memories).values({
      memoryId: candidateMemoryId,
      contactId,
      kind: "preference",
      memoryKey: "tea",
      content: "乌龙茶",
      status: "candidate",
      confidence: 80,
      evidenceMessageIds: [policyMessageId],
      extractedByModel: "deepseek-v4-flash",
    });
    const activatedMemory = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/memories/${candidateMemoryId}/actions`,
      headers: { cookie: cookies[1] },
      payload: {
        action: "activate",
        clientRequestId: "018f47a6-7b9c-7c41-8a36-8e885bd32269",
      },
    });
    expect(activatedMemory.statusCode).toBe(200);
    expect(activatedMemory.json()).toMatchObject({
      memory: { status: "active", content: "乌龙茶" },
      replayed: false,
    });
  });
});

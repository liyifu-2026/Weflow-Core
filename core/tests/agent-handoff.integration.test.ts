import Fastify from "fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { processAgentTurn } from "../modules/agent/application/process-agent-turn.js";
import { registerHandoffRoutes } from "../modules/handoff/interface/http-routes.js";
import { createClosedUser } from "../modules/identity/application/identity-service.js";
import { registerIdentityRoutes } from "../modules/identity/interface/http-routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("agent automatic handoff", () => {
  let postgres: Postgres;
  const server = Fastify();
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationId = `channel:handoff-agent-${suffix}`;
  const contactId = `contact:channel:handoff-agent-${suffix}`;
  const messageId = `handoff-agent-message-${suffix}`;
  const turnId = `handoff-agent-turn-${suffix}`;
  const username = `handoff-agent-${suffix}`;
  const initialPassword = "Initial-handoff-password-1!";
  const newPassword = "Replacement-handoff-password-2!";
  let userId: string;
  let cookie: string;

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "handoff-agent-test"),
    );
    const user = await createClosedUser(postgres.db, username, initialPassword);
    userId = user.userId;
    registerIdentityRoutes(server, postgres.db);
    registerHandoffRoutes(server, postgres.db);
    await server.ready();
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: initialPassword },
    });
    const setCookie = login.headers["set-cookie"];
    if (typeof setCookie !== "string")
      throw new Error("missing session cookie");
    cookie = setCookie.split(";")[0] ?? "";
    const changed = await server.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: initialPassword, newPassword },
    });
    if (changed.statusCode !== 200) throw new Error("password change failed");
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `handoff-agent-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `handoff-agent-${suffix}`,
    });
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      direction: "inbound",
      actorType: "contact",
      contentType: "text",
      channelType: 1,
      text: "我要投诉",
      processingState: "received",
      idempotencyKey: messageId,
      occurredAt: new Date(),
      traceId: messageId,
    });
    await postgres.db.insert(schema.agentTurns).values({
      turnId,
      triggerMessageId: messageId,
      conversationId,
      status: "queued",
      traceId: turnId,
    });
  });

  afterAll(async () => {
    await server.close();
    await postgres.db
      .delete(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.conversationId, conversationId));
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
      .where(eq(schema.agentTurns.turnId, turnId));
    await postgres.db
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    await postgres.db
      .delete(schema.caseStates)
      .where(eq(schema.caseStates.conversationId, conversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, contactId));
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.actorUserId, userId));
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, userId));
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, username));
    await postgres.db
      .delete(schema.userSessions)
      .where(eq(schema.userSessions.userId, userId));
    await postgres.db
      .delete(schema.users)
      .where(eq(schema.users.userId, userId));
    await postgres.close();
  });

  it("pauses the agent and remains idempotent when the policy gate escalates risk", async () => {
    const response = JSON.stringify({
      reply_text: "我先为您转人工处理。",
      next_action: "handoff",
      requires_human: true,
      risk_level: "high",
      handoff_briefing: {
        problem_summary: "客户的设备出现错误码 2272，并明确提出投诉。",
        unresolved_items: ["尚未确认设备授权状态"],
        suggested_first_reply:
          "抱歉让您费心了，我来继续处理。请先把设备序列号发给我。",
      },
    });
    const client = new OpenAiCompatibleClient({
      baseUrl: "https://model.invalid",
      apiKey: "test-only",
      model: "test",
      timeoutMs: 1_000,
      fetch: () =>
        Promise.resolve(
          Response.json({ choices: [{ message: { content: response } }] }),
        ),
    });
    await processAgentTurn(postgres.db, client, "test", {
      turnId,
      traceId: turnId,
    });
    await processAgentTurn(postgres.db, client, "test", {
      turnId,
      traceId: turnId,
    });
    const handoff = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId));
    expect(handoff[0]).toMatchObject({ status: "pending", agentPaused: true });
    const events = await postgres.db
      .select()
      .from(schema.handoffEvents)
      .where(eq(schema.handoffEvents.conversationId, conversationId));
    expect(events).toHaveLength(1);
    const turn = await postgres.db
      .select({
        status: schema.agentTurns.status,
        errorCode: schema.agentTurns.errorCode,
      })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId));
    expect(turn[0]).toMatchObject({
      status: "suppressed_handoff",
      errorCode: "model_requested_handoff",
    });
    const outbound = await postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.direction, "outbound"),
        ),
      );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      actorType: "system",
      sendState: "pending",
      text: "已收到您的情况，已转交专人跟进。",
    });

    const detail = await server.inject({
      method: "GET",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json<{
      handoff: { briefing: schema.HandoffBriefing | null };
    }>();
    expect(detailBody).toMatchObject({
      handoff: {
        briefing: {
          version: 2,
          problemSummary: "客户的设备出现错误码 2272，并明确提出投诉。",
          confirmedFacts: [],
          missingInformation: [],
          unresolvedItems: ["尚未确认设备授权状态"],
          suggestedFirstReply:
            "抱歉让您费心了，我来继续处理。请先把设备序列号发给我。",
          triedSteps: [],
          handoffReason: "policy_gate: model_requested_handoff",
          suggestedNextStep: "根据现有会话上下文继续人工判断。",
          sourceConversationRevision: 1,
        },
      },
    });
    expect(detailBody.handoff.briefing?.generatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });
});

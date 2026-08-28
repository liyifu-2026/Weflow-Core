import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { lockConversationOwnership } from "../infrastructure/postgres/ownership-lock.js";
import { conversationEvents } from "../infrastructure/events/conversation-events.js";
import {
  createHandoff,
  resolveHandoff,
  takeOverHandoff,
} from "../modules/handoff/application/handoff-service.js";
import { registerHandoffRoutes } from "../modules/handoff/interface/http-routes.js";
import { registerContactProfileRoutes } from "../modules/contacts/interface/http-routes.js";
import { createClosedUser } from "../modules/identity/application/identity-service.js";
import { registerIdentityRoutes } from "../modules/identity/interface/http-routes.js";
import { registerConversationRoutes } from "../modules/conversations/interface/http-routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Manual Takeover V2 (Console 全会话访问 + 主动接管)", () => {
  let postgres: Postgres;
  let server: FastifyInstance;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const password = "Manual-takeover-contract-1!";
  const nextPassword = "Manual-takeover-contract-2!";
  const users: Array<{ userId: string; cookie: string; username: string }> = [];
  const conversationIds: string[] = [];
  const contactIds: string[] = [];

  function user(index: number) {
    const value = users[index];
    if (!value) throw new Error(`missing test user ${String(index)}`);
    return value;
  }

  function required<T>(value: T | undefined, label: string): T {
    if (value === undefined) throw new Error(`missing ${label}`);
    return value;
  }

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "manual-takeover-v2-test"),
    );
    server = Fastify();
    registerIdentityRoutes(server, postgres.db);
    registerConversationRoutes(server, postgres.db);
    registerHandoffRoutes(server, postgres.db);
    registerContactProfileRoutes(server, postgres.db);
    await server.ready();
    for (const role of ["me", "other"] as const) {
      const username = `takeover-${role}-${suffix}`;
      const created = await createClosedUser(postgres.db, username, password);
      const login = await server.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username, password },
      });
      const setCookie = login.headers["set-cookie"];
      if (typeof setCookie !== "string") throw new Error("missing cookie");
      const cookie = setCookie.split(";")[0] ?? "";
      const changed = await server.inject({
        method: "POST",
        url: "/api/v1/auth/change-password",
        headers: { cookie },
        payload: { currentPassword: password, newPassword: nextPassword },
      });
      if (changed.statusCode !== 200) throw new Error("password change failed");
      users.push({ userId: created.userId, cookie, username });
    }
  });

  afterAll(async () => {
    await server.close();
    await postgres.db
      .delete(schema.handoffQualityFeedback)
      .where(
        inArray(schema.handoffQualityFeedback.conversationId, conversationIds),
      );
    await postgres.db
      .delete(schema.handoffResolutionSummaryJobs)
      .where(
        inArray(
          schema.handoffResolutionSummaryJobs.conversationId,
          conversationIds,
        ),
      );
    await postgres.db
      .delete(schema.notificationOutbox)
      .where(
        inArray(schema.notificationOutbox.conversationId, conversationIds),
      );
    await postgres.db
      .delete(schema.handoffEvents)
      .where(inArray(schema.handoffEvents.conversationId, conversationIds));
    await postgres.db
      .delete(schema.handoffStates)
      .where(inArray(schema.handoffStates.conversationId, conversationIds));
    await postgres.db
      .delete(schema.handoffCycles)
      .where(inArray(schema.handoffCycles.conversationId, conversationIds));
    await postgres.db
      .delete(schema.agentTurns)
      .where(inArray(schema.agentTurns.conversationId, conversationIds));
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(
        inArray(schema.memoryCaptureStates.conversationId, conversationIds),
      );
    await postgres.db
      .delete(schema.messages)
      .where(inArray(schema.messages.conversationId, conversationIds));
    await postgres.db
      .delete(schema.conversations)
      .where(inArray(schema.conversations.conversationId, conversationIds));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(inArray(schema.contactProfiles.contactId, contactIds));
    await postgres.db.delete(schema.auditEvents).where(
      inArray(
        schema.auditEvents.actorUserId,
        users.map((entry) => entry.userId),
      ),
    );
    await postgres.db.delete(schema.userSessions).where(
      inArray(
        schema.userSessions.userId,
        users.map((entry) => entry.userId),
      ),
    );
    await postgres.db.delete(schema.users).where(
      inArray(
        schema.users.userId,
        users.map((entry) => entry.userId),
      ),
    );
    await postgres.close();
  });

  // ---------- 种子辅助 ----------

  async function seedAgentActive(label: string) {
    const conversationId = `channel:takeover-${label}-${suffix}`;
    const contactId = `contact:takeover-${label}-${suffix}`;
    conversationIds.push(conversationId);
    contactIds.push(contactId);
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `takeover-${label}-${suffix}`,
      channelDisplayName: `客户-${label}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `takeover-${label}-${suffix}`,
    });
    const triggerMessageId = await insertCustomerMessage(
      conversationId,
      "设备更新后无法启动。",
    );
    return { conversationId, triggerMessageId };
  }

  async function seedPending(label: string) {
    const { conversationId } = await seedAgentActive(label);
    const result = await createHandoff(postgres.db, {
      conversationId,
      actorUserId: "system-agent",
      clientRequestId: randomUUID(),
      summary: "Agent 无法确认恢复方案",
      sourceIp: "server2",
    });
    expect(result.status).toBe("ok");
    return conversationId;
  }

  async function insertCustomerMessage(conversationId: string, text: string) {
    const messageId = `takeover-message:${conversationId}:${randomUUID()}`;
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text,
      processingState: "received",
      idempotencyKey: `takeover-message:${conversationId}:${randomUUID()}`,
      occurredAt: new Date(),
      traceId: `takeover-message:${conversationId}:${randomUUID()}`,
    });
    return messageId;
  }

  function takeover(conversationId: string, cookie: string, extra?: object) {
    return server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/take-over`,
      headers: { cookie },
      payload: { clientRequestId: randomUUID(), ...extra },
    });
  }

  /** pending → Claim Handoff（命令边界：pending 不走 manual takeover） */
  async function claim(conversationId: string, cookie: string) {
    const state = await stateOf(conversationId);
    return server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/accept`,
      headers: { cookie },
      payload: {
        expectedHandoffRevision: state.handoffRevision,
        clientRequestId: randomUUID(),
      },
    });
  }

  async function stateOf(conversationId: string) {
    return required(
      (
        await postgres.db
          .select()
          .from(schema.handoffStates)
          .where(eq(schema.handoffStates.conversationId, conversationId))
      )[0],
      `handoff state ${conversationId}`,
    );
  }

  async function list(cookie: string, query = "") {
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/conversations?limit=100${query}`,
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{
      conversations: Array<{
        conversationId: string;
        handoff: {
          status: string;
          assignedUserId: string | null;
          agentPaused: boolean;
        } | null;
        permissions: {
          canView: boolean;
          canManualTakeover: boolean;
          canReply: boolean;
          canTransfer: boolean;
          canFinish: boolean;
        };
      }>;
      nextCursor?: string;
    }>();
  }

  /**
   * 模拟 Agent 落库提交路径（与 AgentTurnExecutor 的提交路径同构）：ownership 锁 → 读
   * agentPaused → 已暂停则抑制（不插消息），否则插入出站消息。用于验证锁不变式。
   */
  async function simulateAgentCommit(conversationId: string) {
    return postgres.db.transaction(async (transaction) => {
      await lockConversationOwnership(transaction, conversationId);
      const [handoff] = await transaction
        .select({ agentPaused: schema.handoffStates.agentPaused })
        .from(schema.handoffStates)
        .where(eq(schema.handoffStates.conversationId, conversationId))
        .limit(1);
      if (handoff?.agentPaused) return "suppressed" as const;
      await transaction.insert(schema.messages).values({
        messageId: `agent-commit:${conversationId}:${randomUUID()}`,
        conversationId,
        direction: "outbound",
        actorType: "agent",
        actorId: null,
        contentType: "text",
        channelType: 1,
        text: "模拟 Agent 落库回复",
        processingState: "not_applicable",
        sendState: "pending",
        idempotencyKey: `agent-commit:${conversationId}:${randomUUID()}`,
        occurredAt: new Date(),
        traceId: `agent-commit:${conversationId}:${randomUUID()}`,
      });
      return "committed" as const;
    });
  }

  async function agentCommitMessages(conversationId: string) {
    return postgres.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.actorType, "agent"),
        ),
      );
  }

  // ---------- 业务场景 ----------

  it("AGENT_ACTIVE 会话主动接管 → 201 in_progress，审计 manual_taken_over + takeoverType=manual", async () => {
    const { conversationId } = await seedAgentActive("basic");
    const response = await takeover(conversationId, user(0).cookie, {
      sourceConversationRevision: 1,
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<{
      handoff: { status: string; assignedUserId: string; agentPaused: boolean };
    }>();
    expect(body.handoff.status).toBe("in_progress");
    expect(body.handoff.assignedUserId).toBe(user(0).userId);
    expect(body.handoff.agentPaused).toBe(true);
    const audit = await postgres.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.actorUserId, user(0).userId),
          eq(schema.auditEvents.eventType, "handoff.manual_taken_over"),
        ),
      );
    const entry = audit[0];
    expect(entry).toBeDefined();
    expect(entry?.metadata).toMatchObject({
      takeoverType: "manual",
      sourceConversationRevision: "1",
    });
  });

  it("两名客服同时接管 AGENT_ACTIVE → 恰一人 201，另一人 409 handoff_already_claimed", async () => {
    const { conversationId } = await seedAgentActive("race");
    const [first, second] = await Promise.all([
      takeover(conversationId, user(0).cookie),
      takeover(conversationId, user(1).cookie),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    const loser = first.statusCode === 409 ? first : second;
    const loserBody = loser.json<{
      error: string;
      handoff: { status: string };
      assignee: { userId: string } | undefined;
    }>();
    expect(loserBody.error).toBe("handoff_already_claimed");
    expect(loserBody.handoff.status).toBe("in_progress");
    expect(loserBody.assignee?.userId).toBeDefined();
    const state = await stateOf(conversationId);
    expect([user(0).userId, user(1).userId]).toContain(state.assignedUserId);
  });

  it("命令边界：pending 上 take-over → 409；AGENT_ACTIVE 上 accept → 409", async () => {
    const pendingId = await seedPending("command-pending");
    const onPending = await takeover(pendingId, user(0).cookie);
    expect(onPending.statusCode).toBe(409);
    expect(onPending.json<{ error: string }>().error).toBe(
      "invalid_handoff_transition",
    );

    const { conversationId: agentActiveId } =
      await seedAgentActive("command-active");
    const onActive = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(agentActiveId)}/handoff/accept`,
      headers: { cookie: user(0).cookie },
      payload: { expectedHandoffRevision: 1, clientRequestId: randomUUID() },
    });
    // 无 handoff 可认领：404 handoff_not_found 或 409 revision 冲突均可，重点是失败
    expect([404, 409]).toContain(onActive.statusCode);
  });

  it("接管后 queued/running turn → suppressed_handoff，pending agent 消息 → cancelled_handoff", async () => {
    const { conversationId, triggerMessageId } =
      await seedAgentActive("suppress");
    const turnId = `turn:${conversationId}:${randomUUID()}`;
    await postgres.db.insert(schema.agentTurns).values({
      turnId,
      triggerMessageId,
      conversationId,
      status: "queued",
      traceId: `turn:${conversationId}:${randomUUID()}`,
      createdAt: new Date(),
    });
    const pendingMessageId = `agent-pending:${conversationId}:${randomUUID()}`;
    await postgres.db.insert(schema.messages).values({
      messageId: pendingMessageId,
      conversationId,
      direction: "outbound",
      actorType: "agent",
      actorId: null,
      contentType: "text",
      channelType: 1,
      text: "尚未发出的 Agent 回复",
      processingState: "not_applicable",
      sendState: "pending",
      idempotencyKey: `agent-pending:${conversationId}:${randomUUID()}`,
      occurredAt: new Date(),
      traceId: `agent-pending:${conversationId}:${randomUUID()}`,
    });
    const response = await takeover(conversationId, user(0).cookie);
    expect(response.statusCode).toBe(201);
    const turn = required(
      (
        await postgres.db
          .select()
          .from(schema.agentTurns)
          .where(eq(schema.agentTurns.turnId, turnId))
      )[0],
      "turn",
    );
    expect(turn.status).toBe("suppressed_handoff");
    const message = required(
      (
        await postgres.db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.messageId, pendingMessageId))
      )[0],
      "pending agent message",
    );
    expect(message.sendState).toBe("cancelled_handoff");
  });

  it("能看≠能回复：无接管时人工回复 403；接管后 202", async () => {
    const { conversationId } = await seedAgentActive("reply-gate");
    const blocked = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      headers: { cookie: user(0).cookie },
      payload: { text: "未经接管直接回复", clientRequestId: randomUUID() },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: string }>().error).toBe(
      "handoff_not_assignee",
    );

    const response = await takeover(conversationId, user(0).cookie);
    expect(response.statusCode).toBe(201);
    const reply = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      headers: { cookie: user(0).cookie },
      payload: { text: "我来处理", clientRequestId: randomUUID() },
    });
    expect(reply.statusCode).toBe(202);
  });

  it("接管幂等：相同 clientRequestId 重放返回 200 replayed=true", async () => {
    const { conversationId } = await seedAgentActive("idempotent");
    const clientRequestId = randomUUID();
    const first = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/take-over`,
      headers: { cookie: user(0).cookie },
      payload: { clientRequestId },
    });
    expect(first.statusCode).toBe(201);
    const second = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/take-over`,
      headers: { cookie: user(0).cookie },
      payload: { clientRequestId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ replayed: boolean }>().replayed).toBe(true);
  });

  it("take-over 发布 ownership_changed；accept 仍发布 handoff_claimed", async () => {
    const { conversationId: takeoverId } =
      await seedAgentActive("event-takeover");
    const claimId = await seedPending("event-claim");
    const events: Array<{
      type: string;
      conversationId: string;
    }> = [];
    const unsubscribe = conversationEvents.on((event) => {
      events.push(event);
    });
    try {
      const takeoverResponse = await takeover(takeoverId, user(0).cookie);
      expect(takeoverResponse.statusCode).toBe(201);
      const revision = required(
        (
          await postgres.db
            .select({ revision: schema.handoffStates.handoffRevision })
            .from(schema.handoffStates)
            .where(eq(schema.handoffStates.conversationId, claimId))
        )[0],
        "claim revision",
      ).revision;
      const claimResponse = await server.inject({
        method: "POST",
        url: `/api/v1/conversations/${encodeURIComponent(claimId)}/handoff/accept`,
        headers: { cookie: user(0).cookie },
        payload: {
          expectedHandoffRevision: revision,
          clientRequestId: randomUUID(),
        },
      });
      expect(claimResponse.statusCode).toBe(201);
    } finally {
      unsubscribe();
    }
    expect(
      events.some(
        (event) =>
          event.type === "ownership_changed" &&
          event.conversationId === takeoverId,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "handoff_claimed" && event.conversationId === claimId,
      ),
    ).toBe(true);
  });

  it("锁不变式：接管先提交 → Agent 落库被抑制；Agent 先提交 → 消息保留且接管仍成功", async () => {
    const { conversationId } = await seedAgentActive("lock-invariant");
    const [takeoverResult, commitResult] = await Promise.all([
      takeOverHandoff(postgres.db, {
        conversationId,
        actorUserId: user(0).userId,
        clientRequestId: randomUUID(),
        summary: "主动接管",
        sourceIp: "test",
      }),
      simulateAgentCommit(conversationId),
    ]);
    expect(takeoverResult.status).toBe("ok");
    const state = await stateOf(conversationId);
    expect(state.status).toBe("in_progress");
    expect(state.agentPaused).toBe(true);
    const committedMessages = await agentCommitMessages(conversationId);
    // 不变式：agent 消息落地 ⟺ agent 提交路径在锁内看到未暂停
    if (commitResult === "committed") {
      expect(committedMessages.length).toBe(1);
    } else {
      expect(committedMessages.length).toBe(0);
    }
  });

  it("锁不变式（确定性）：先接管再 Agent 落库 → 必被抑制", async () => {
    const { conversationId } = await seedAgentActive("lock-sequential");
    const response = await takeover(conversationId, user(0).cookie);
    expect(response.statusCode).toBe(201);
    const commitResult = await simulateAgentCommit(conversationId);
    expect(commitResult).toBe("suppressed");
    expect(await agentCommitMessages(conversationId)).toHaveLength(0);
  });

  it("scope 四值与 permissions：attention/mine/others/all", async () => {
    const { conversationId: agentActiveId } =
      await seedAgentActive("scope-active");
    const pendingId = await seedPending("scope-pending");
    const mineId = await seedPending("scope-mine");
    const mineClaim = await claim(mineId, user(0).cookie);
    expect(mineClaim.statusCode).toBe(201);
    const otherId = await seedPending("scope-other");
    const otherClaim = await claim(otherId, user(1).cookie);
    expect(otherClaim.statusCode).toBe(201);
    const resolvedId = await seedPending("scope-resolved");
    const resolvedClaim = await claim(resolvedId, user(0).cookie);
    expect(resolvedClaim.statusCode).toBe(201);
    const resolveResult = await resolveHandoff(postgres.db, {
      conversationId: resolvedId,
      actorUserId: user(0).userId,
      clientRequestId: randomUUID(),
      summary: "已处理完成",
      sourceIp: "test",
    });
    expect(resolveResult.status).toBe("ok");

    const all = await list(user(0).cookie, "&scope=all");
    expect(all.conversations.map((entry) => entry.conversationId)).toEqual(
      expect.arrayContaining([
        agentActiveId,
        pendingId,
        mineId,
        otherId,
        resolvedId,
      ]),
    );

    const attention = await list(user(0).cookie, "&scope=attention");
    const attentionIds = attention.conversations.map(
      (entry) => entry.conversationId,
    );
    expect(attentionIds).toContain(pendingId);
    expect(attentionIds).not.toContain(agentActiveId);
    expect(attentionIds).not.toContain(mineId);
    expect(attentionIds).not.toContain(otherId);
    expect(attentionIds).not.toContain(resolvedId);

    const mine = await list(user(0).cookie, "&scope=mine");
    const mineIds = mine.conversations.map((entry) => entry.conversationId);
    expect(mineIds).toContain(mineId);
    expect(mineIds).not.toContain(agentActiveId);
    expect(mineIds).not.toContain(pendingId);
    expect(mineIds).not.toContain(otherId);
    expect(mineIds).not.toContain(resolvedId);

    const others = await list(user(0).cookie, "&scope=others");
    const othersIds = others.conversations.map((entry) => entry.conversationId);
    expect(othersIds).toEqual(
      expect.arrayContaining([agentActiveId, otherId, resolvedId]),
    );
    expect(othersIds).not.toContain(pendingId);
    expect(othersIds).not.toContain(mineId);

    // permissions（锁定模型）：canManualTakeover 仅 AGENT_ACTIVE 为 true
    const byId = new Map(
      all.conversations.map((entry) => [entry.conversationId, entry]),
    );
    expect(
      required(byId.get(agentActiveId), "active").permissions,
    ).toMatchObject({
      canManualTakeover: true,
      canReply: false,
      canTransfer: false,
      canFinish: false,
    });
    expect(required(byId.get(pendingId), "pending").permissions).toMatchObject({
      canManualTakeover: false,
      canReply: false,
    });
    expect(required(byId.get(mineId), "mine").permissions).toMatchObject({
      canManualTakeover: false,
      canReply: true,
      canTransfer: true,
      canFinish: true,
    });
    expect(required(byId.get(otherId), "other").permissions).toMatchObject({
      canManualTakeover: false,
      canReply: false,
    });
    expect(
      required(byId.get(resolvedId), "resolved").permissions,
    ).toMatchObject({
      canManualTakeover: true,
      canReply: false,
    });
  });

  it("列表游标分页：无漏无重", async () => {
    for (const label of ["page-1", "page-2", "page-3", "page-4", "page-5"]) {
      await seedAgentActive(label);
    }
    const first = await server.inject({
      method: "GET",
      url: "/api/v1/conversations?limit=2&scope=all",
      headers: { cookie: user(0).cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      conversations: Array<{ conversationId: string }>;
      nextCursor?: string;
    }>();
    expect(firstBody.conversations).toHaveLength(2);
    expect(firstBody.nextCursor).toBeDefined();
    const second = await server.inject({
      method: "GET",
      url: `/api/v1/conversations?limit=2&scope=all&before=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
      headers: { cookie: user(0).cookie },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{
      conversations: Array<{ conversationId: string }>;
    }>();
    expect(secondBody.conversations).toHaveLength(2);
    const ids = [
      ...firstBody.conversations.map((entry) => entry.conversationId),
      ...secondBody.conversations.map((entry) => entry.conversationId),
    ];
    expect(new Set(ids).size).toBe(4);
  });

  it("GET /api/v1/console/capabilities 返回 conversationPermissions", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/console/capabilities",
      headers: { cookie: user(0).cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ capabilities: Record<string, boolean> }>()).toEqual({
      capabilities: { conversationPermissions: true },
    });
  });

  it("mobile capabilities 含 mobileManualTakeover", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/mobile/capabilities",
      headers: { cookie: user(0).cookie },
    });
    expect(response.statusCode).toBe(200);
    const capabilities = response.json<{
      capabilities: Record<string, boolean>;
    }>().capabilities;
    expect(capabilities.mobileManualTakeover).toBe(true);
  });

  it("mobile（Bearer token）主动接管 AGENT_ACTIVE → 201；outcome 查询 succeeded", async () => {
    // mobile 会话：/api/v1/mobile/auth/login 返回 sessionToken（Bearer）
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/mobile/auth/login",
      payload: { username: user(0).username, password: nextPassword },
    });
    expect(login.statusCode).toBe(200);
    const sessionToken = login.json<{ sessionToken?: string }>().sessionToken;
    if (!sessionToken) throw new Error("missing session token");

    const { conversationId } = await seedAgentActive("mobile-bearer");
    const clientRequestId = randomUUID();
    const takeover = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/take-over`,
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { clientRequestId },
    });
    expect(takeover.statusCode, takeover.body).toBe(201);
    const body = takeover.json<{
      handoff: { status: string; assignedUserId: string };
    }>();
    expect(body.handoff.status).toBe("in_progress");
    expect(body.handoff.assignedUserId).toBe(user(0).userId);

    // outcome 查询：legacy transition 事件已补 outcomeStatus → succeeded
    const outcome = await server.inject({
      method: "GET",
      url: `/api/v1/mobile/request-outcomes?operation=take_over&clientRequestId=${clientRequestId}`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(outcome.statusCode).toBe(200);
    expect(outcome.json<{ status: string }>().status).toBe("succeeded");
  });

  it("mobile 双人并发接管（Bearer）→ 恰一人 201", async () => {
    const tokens: string[] = [];
    for (const entry of [user(0), user(1)]) {
      const login = await server.inject({
        method: "POST",
        url: "/api/v1/mobile/auth/login",
        payload: { username: entry.username, password: nextPassword },
      });
      const token = login.json<{ sessionToken?: string }>().sessionToken;
      if (!token) throw new Error("missing session token");
      tokens.push(token);
    }
    const { conversationId } = await seedAgentActive("mobile-race");
    const [first, second] = await Promise.all([
      server.inject({
        method: "POST",
        url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/take-over`,
        headers: { authorization: `Bearer ${tokens[0] ?? ""}` },
        payload: { clientRequestId: randomUUID() },
      }),
      server.inject({
        method: "POST",
        url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/take-over`,
        headers: { authorization: `Bearer ${tokens[1] ?? ""}` },
        payload: { clientRequestId: randomUUID() },
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
  });
});

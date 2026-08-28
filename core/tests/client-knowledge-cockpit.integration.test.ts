import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../infrastructure/auth/password.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { login } from "../modules/identity/application/identity-service.js";
import { registerKnowledgeRoutes } from "../modules/knowledge/interface/http-routes.js";
import { randomUUID } from "node:crypto";
import { createHandoff } from "../modules/handoff/application/handoff-service.js";
import { buildHandoffBriefing } from "../modules/handoff/application/handoff-briefing.js";
import type {
  KnowledgeChatCompletionModel,
  KnowledgeProvider,
} from "../modules/knowledge/contracts/knowledge-search.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Mobile knowledge cockpit trust boundaries", () => {
  let postgres: Postgres;
  const server = Fastify();
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const userIdA = `kc-a-${String(Date.now()).slice(-10)}-${String(process.pid)}`;
  const userIdB = `kc-b-${String(Date.now()).slice(-10)}-${String(process.pid)}`;
  const userA = `knowledge-a-${suffix}`.slice(0, 64);
  const userB = `knowledge-b-${suffix}`.slice(0, 64);
  const conversationId = `knowledge-cockpit-${suffix}`;
  const contactId = `contact:channel:knowledge-cockpit-${suffix}`;
  let tokenA = "";
  let tokenB = "";
  let threadId = "";
  let usedFullKnowledgeStream = false;
  let completeCalls = 0;

  const weknora = {
    createSession: () => "weknora-session-test",
    search: (query: string) => {
      if (query !== "chunk-1") return [];
      return [
        {
          chunkId: "chunk-1",
          knowledgeId: "doc-1",
          knowledgeBaseId: "kb-1",
          title: "可信手册",
          filename: "trusted.pdf",
          source: "file",
          chunkType: "text",
          content: "服务器校验后的可信片段",
          matchedContent: "可信片段",
          score: 0.99,
          startAt: 4,
          endAt: 8,
        },
      ];
    },
    streamKnowledgeQA: () => {
      usedFullKnowledgeStream = true;
      throw new Error("selected evidence must not call full knowledge stream");
    },
    ensureSuggestions: () => undefined,
  } as unknown as KnowledgeProvider;
  const model = {
    complete: () => {
      completeCalls += 1;
      return Promise.resolve(
        completeCalls === 1
          ? "只基于受信证据生成的回答"
          : JSON.stringify({
              reply: "只基于受信证据生成的回答",
              followUps: [],
              troubleshootingSteps: [],
              risks: [],
              referenceIds: ["chunk-1"],
            }),
      );
    },
  } satisfies KnowledgeChatCompletionModel;

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger(
        { logLevel: "silent" },
        "knowledge-cockpit-integration-test",
      ),
    );
    const passwordHash = await hashPassword("Knowledge-test-password-1!");
    await postgres.db.insert(schema.users).values([
      {
        userId: userIdA,
        username: userA,
        passwordHash,
        mustChangePassword: false,
        status: "active",
      },
      {
        userId: userIdB,
        username: userB,
        passwordHash,
        mustChangePassword: false,
        status: "active",
      },
    ]);
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `knowledge-contact-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `knowledge-conversation-${suffix}`,
    });
    const loggedInA = await login(
      postgres.db,
      userA,
      "Knowledge-test-password-1!",
      "127.0.0.1",
    );
    const loggedInB = await login(
      postgres.db,
      userB,
      "Knowledge-test-password-1!",
      "127.0.0.1",
    );
    if (!loggedInA || !loggedInB) throw new Error("integration login failed");
    tokenA = loggedInA.token;
    tokenB = loggedInB.token;
    registerKnowledgeRoutes(server, postgres.db, { weknora, model });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    // 并行 worker 会为所有活跃用户入队通知，先清理避免 users 外键冲突。
    await postgres.db
      .delete(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.userId, userIdA));
    await postgres.db
      .delete(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.userId, userIdB));
    await postgres.db
      .delete(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId));
    await postgres.db
      .delete(schema.handoffCycles)
      .where(eq(schema.handoffCycles.conversationId, conversationId));
    await postgres.db
      .delete(schema.clientKnowledgeThreads)
      .where(eq(schema.clientKnowledgeThreads.userId, userIdA));
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, conversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, contactId));
    await postgres.db
      .delete(schema.userSessions)
      .where(eq(schema.userSessions.userId, userIdA));
    await postgres.db
      .delete(schema.userSessions)
      .where(eq(schema.userSessions.userId, userIdB));
    await postgres.db
      .delete(schema.users)
      .where(eq(schema.users.username, userA));
    await postgres.db
      .delete(schema.users)
      .where(eq(schema.users.username, userB));
    await postgres.close();
  });

  it("validates evidence IDs, snapshots server content, and isolates trays by account", async () => {
    const malicious = await server.inject({
      method: "PUT",
      url: `/api/v1/conversations/${conversationId}/knowledge/evidence-tray`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { evidence: [{ chunkId: "not-real", knowledgeId: "doc-1" }] },
    });
    expect(malicious.statusCode).toBe(404);

    const added = await server.inject({
      method: "PUT",
      url: `/api/v1/conversations/${conversationId}/knowledge/evidence-tray`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { evidence: [{ chunkId: "chunk-1", knowledgeId: "doc-1" }] },
    });
    expect(added.statusCode).toBe(200);
    const addedBody = JSON.parse(added.body) as {
      evidence: Array<Record<string, unknown>>;
    };
    const snapshot = addedBody.evidence[0];
    expect(snapshot?.evidenceId).toBe("chunk-1");
    expect(snapshot?.excerpt).toBe("服务器校验后的可信片段");
    expect(typeof snapshot?.addedBy).toBe("string");
    expect(typeof snapshot?.sourceHash).toBe("string");

    const otherAccount = await server.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/knowledge/evidence-tray`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(otherAccount.statusCode).toBe(200);
    expect(otherAccount.json()).toMatchObject({ evidence: [] });
  });

  it("uses only the trusted tray in selected-evidence mode and isolates the thread", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/knowledge/answer/stream",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        conversationId,
        query: "怎么处理？",
        selectedEvidenceIds: ["chunk-1"],
        outputMode: "reply",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("只基于受信证据生成的回答");
    expect(response.body).toContain('"type":"reply_suggestion"');
    expect(response.body).toContain('"sourceRevision":0');
    expect(response.body).toContain('"evidenceIds":["chunk-1"]');
    expect(response.body).toContain('"generationStatus":"complete"');
    expect(response.body).toContain('"type":"complete"');
    expect(usedFullKnowledgeStream).toBe(false);
    const started = response.body.match(/"type":"started"[^\n]+/u)?.[0];
    threadId = started?.match(/"threadId":"([^"]+)"/u)?.[1] ?? "";
    expect(threadId).toMatch(/^knowledge-thread:/u);

    const otherThread = await server.inject({
      method: "GET",
      url: `/api/v1/knowledge/threads/${encodeURIComponent(threadId)}/messages`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(otherThread.statusCode).toBe(404);

    const ownThread = await server.inject({
      method: "GET",
      url: `/api/v1/knowledge/threads/${encodeURIComponent(threadId)}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(ownThread.statusCode).toBe(200);
    const messages = (
      JSON.parse(ownThread.body) as {
        messages: Array<{
          role: string;
          content: string;
          metadata: {
            queryOptions?: Record<string, unknown>;
            actionOutput?: Record<string, unknown> | null;
            replySuggestion?: Record<string, unknown> | null;
            conversationRevision?: number | null;
          };
        }>;
      }
    ).messages;
    const userMessage = messages.find((item) => item.role === "user");
    expect(userMessage?.content).toBe("怎么处理？");
    expect(userMessage?.metadata.queryOptions?.selectedEvidenceIds).toEqual([
      "chunk-1",
    ]);
    const assistantMessage = messages.find((item) => item.role === "assistant");
    expect(assistantMessage?.metadata.actionOutput).toMatchObject({
      reply: "只基于受信证据生成的回答",
      referenceIds: ["chunk-1"],
    });
    expect(typeof assistantMessage?.metadata.conversationRevision).toBe(
      "number",
    );
    expect(assistantMessage?.metadata.replySuggestion).toMatchObject({
      text: "只基于受信证据生成的回答",
      sourceRevision: 0,
      evidenceIds: ["chunk-1"],
      generationStatus: "complete",
    });
  });

  it("filters thread history by scope and enriches conversation metadata", async () => {
    const standaloneThreadId = `knowledge-thread:standalone-${suffix}`;
    await postgres.db.insert(schema.clientKnowledgeThreads).values({
      threadId: standaloneThreadId,
      userId: userIdA,
      scopeType: "standalone",
      scopeId: "standalone",
      weknoraSessionId: "weknora-session-test",
      title: "独立查询：如何重置密码",
    });
    await postgres.db
      .update(schema.contactProfiles)
      .set({ channelDisplayName: "知识测试联系人" })
      .where(eq(schema.contactProfiles.contactId, contactId));
    const cycleId = `knowledge-cycle-${suffix}`;
    await postgres.db.insert(schema.handoffCycles).values({
      cycleId,
      conversationId,
      status: "in_progress",
      reason: "knowledge integration test",
      createdByUserId: userIdA,
      assignedUserId: userIdA,
    });
    await postgres.db.insert(schema.handoffStates).values({
      conversationId,
      cycleId,
      status: "in_progress",
      reason: "knowledge integration test",
      createdByUserId: userIdA,
      assignedUserId: userIdA,
    });

    const standalone = await server.inject({
      method: "GET",
      url: "/api/v1/knowledge/threads?scopeType=standalone",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(standalone.statusCode).toBe(200);
    const standaloneThreads = (
      JSON.parse(standalone.body) as {
        threads: Array<{ threadId: string; scopeType: string }>;
      }
    ).threads;
    expect(
      standaloneThreads.some((item) => item.threadId === standaloneThreadId),
    ).toBe(true);
    expect(
      standaloneThreads.some((item) => item.scopeType === "conversation"),
    ).toBe(false);

    const conversation = await server.inject({
      method: "GET",
      url: `/api/v1/knowledge/threads?scopeType=conversation&scopeId=${encodeURIComponent(conversationId)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(conversation.statusCode).toBe(200);
    const conversationThreads = (
      JSON.parse(conversation.body) as {
        threads: Array<{
          threadId: string;
          scopeType: string;
          conversationDisplayName?: string;
          conversationStatus?: string;
        }>;
      }
    ).threads;
    expect(conversationThreads.some((item) => item.threadId === threadId)).toBe(
      true,
    );
    expect(
      conversationThreads.some((item) => item.scopeType === "standalone"),
    ).toBe(false);
    expect(
      conversationThreads.every(
        (item) => item.conversationDisplayName === "知识测试联系人",
      ),
    ).toBe(true);
    expect(
      conversationThreads.every(
        (item) => item.conversationStatus === "in_progress",
      ),
    ).toBe(true);

    const otherAccount = await server.inject({
      method: "GET",
      url: `/api/v1/knowledge/threads?scopeType=conversation&scopeId=${encodeURIComponent(conversationId)}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(
      (JSON.parse(otherAccount.body) as { threads: unknown[] }).threads,
    ).toHaveLength(0);

    const missingScopeId = await server.inject({
      method: "GET",
      url: "/api/v1/knowledge/threads?scopeType=conversation",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(missingScopeId.statusCode).toBe(400);
  });

  it("Fast Path：reply 模式且已有结构化 Brief 时跳过检索直接生成", async () => {
    const fastConversationId = `channel:knowledge-fast-${suffix}`;
    const fastContactId = `contact:channel:knowledge-fast-${suffix}`;
    await postgres.db.insert(schema.contactProfiles).values({
      contactId: fastContactId,
      channel: "channel",
      channelContactId: `knowledge-fast-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId: fastConversationId,
      contactId: fastContactId,
      channel: "channel",
      channelConversationId: `knowledge-fast-${suffix}`,
    });
    await postgres.db.insert(schema.messages).values({
      messageId: `knowledge-fast-msg-${suffix}`,
      conversationId: fastConversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text: "门锁完全不亮",
      processingState: "received",
      idempotencyKey: `knowledge-fast-idem-${suffix}`,
      occurredAt: new Date(),
      traceId: `knowledge-fast-${suffix}`,
    });
    await createHandoff(postgres.db, {
      conversationId: fastConversationId,
      actorUserId: "system-agent",
      clientRequestId: randomUUID(),
      summary: "fast path 测试",
      sourceIp: "server2",
      briefing: buildHandoffBriefing({
        sourceConversationRevision: 0,
        handoffReason: "门锁离线",
      }),
    });
    const usedBefore = usedFullKnowledgeStream;
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/knowledge/answer/stream",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        conversationId: fastConversationId,
        query: "门锁完全不亮",
        outputMode: "reply",
      },
    });
    expect(response.statusCode).toBe(200);
    // 走 Fast Path：不触碰 WeKnora 全量检索
    expect(usedFullKnowledgeStream).toBe(usedBefore);
    expect(response.body).toContain('"type":"started"');
    expect(response.body).toContain('"streamId":"fast-path-');
    expect(response.body).toContain('"type":"reply_suggestion"');
    expect(response.body).toContain('"type":"complete"');
    expect(response.body).toContain('"evidenceIds":[]');
  });
});

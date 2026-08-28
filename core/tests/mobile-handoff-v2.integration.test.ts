import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { buildAgentContext } from "../modules/agent/application/agent-context.js";
import { buildHandoffBriefing } from "../modules/handoff/application/handoff-briefing.js";
import { createHandoff } from "../modules/handoff/application/handoff-service.js";
import {
  processResolutionSummaryJobs,
  reconcileExpiredTransfers,
} from "../modules/handoff/application/mobile-handoff-service.js";
import { registerHandoffRoutes } from "../modules/handoff/interface/http-routes.js";
import { registerContactProfileRoutes } from "../modules/contacts/interface/http-routes.js";
import { createClosedUser } from "../modules/identity/application/identity-service.js";
import { registerIdentityRoutes } from "../modules/identity/interface/http-routes.js";
import { registerConversationRoutes } from "../modules/conversations/interface/http-routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Mobile Handoff V2 real business scenarios", () => {
  let postgres: Postgres;
  let server: FastifyInstance;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const password = "Mobile-handoff-contract-1!";
  const nextPassword = "Mobile-handoff-contract-2!";
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
      createLogger({ logLevel: "silent" }, "mobile-handoff-v2-test"),
    );
    server = Fastify();
    registerIdentityRoutes(server, postgres.db);
    registerConversationRoutes(server, postgres.db);
    registerHandoffRoutes(server, postgres.db);
    registerContactProfileRoutes(server, postgres.db);
    await server.ready();
    for (const role of ["owner", "target", "member", "racer"] as const) {
      const username = `mobile-${role}-${suffix}`;
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
    await postgres.db.insert(schema.queueMembers).values([
      {
        membershipId: randomUUID(),
        queueId: "queue-device-fault",
        userId: user(1).userId,
      },
      {
        membershipId: randomUUID(),
        queueId: "queue-device-fault",
        userId: user(2).userId,
      },
    ]);
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
    await postgres.db.delete(schema.queueMembers).where(
      inArray(
        schema.queueMembers.userId,
        users.map((user) => user.userId),
      ),
    );
    await postgres.db.delete(schema.auditEvents).where(
      inArray(
        schema.auditEvents.actorUserId,
        users.map((user) => user.userId),
      ),
    );
    await postgres.db.delete(schema.userSessions).where(
      inArray(
        schema.userSessions.userId,
        users.map((user) => user.userId),
      ),
    );
    await postgres.db.delete(schema.users).where(
      inArray(
        schema.users.userId,
        users.map((user) => user.userId),
      ),
    );
    await postgres.close();
  });

  it("Agent 普通转人工只进入专用 Mobile Inbox", async () => {
    const conversationId = await seedHandoff("ordinary");
    const response = await inbox(user(0).cookie);
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response.json<{ items: Array<{ conversationId: string }> }>().items,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ conversationId })]),
    );
    const detail = await server.inject({
      method: "GET",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff`,
      headers: { cookie: user(0).cookie },
    });
    const detailBody = detail.json<{
      handoff: { state: { cycleId: string }; briefing: { version: number } };
    }>();
    const briefRequestId = randomUUID();
    const feedback = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/brief-feedback`,
      headers: { cookie: user(0).cookie },
      payload: {
        cycleId: detailBody.handoff.state.cycleId,
        briefVersion: detailBody.handoff.briefing.version,
        clientRequestId: briefRequestId,
      },
    });
    expect(feedback.statusCode).toBe(201);
  });

  it("两名客服并发接手时严格只有一人获得发送权", async () => {
    const conversationId = await seedHandoff("race");
    const revision = await currentRevision(conversationId);
    const [first, second] = await Promise.all([
      claim(conversationId, user(0).cookie, revision),
      claim(conversationId, user(3).cookie, revision),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    const state = required(
      (
        await postgres.db
          .select()
          .from(schema.handoffStates)
          .where(eq(schema.handoffStates.conversationId, conversationId))
      )[0],
      "race state",
    );
    expect(state.status).toBe("in_progress");
    expect([user(0).userId, user(3).userId]).toContain(state.assignedUserId);
  });

  it("转给具体客服后必须由目标客服明确接手", async () => {
    const conversationId = await seedOwned("direct-accept");
    const transfer = await transferToUser(conversationId, user(1).userId);
    expect(transfer.statusCode).toBe(201);
    const pending = transfer.json<{
      handoff: { status: string; acceptBy: string };
    }>().handoff;
    expect(pending.status).toBe("TRANSFER_PENDING");
    expect(new Date(pending.acceptBy).getTime()).toBeGreaterThan(Date.now());
    const targetItems = inboxItems(await inbox(user(1).cookie));
    expect(
      targetItems.find((item) => item.conversationId === conversationId)
        ?.handoff.status,
    ).toBe("TRANSFER_PENDING");
    const accepted = await claim(
      conversationId,
      user(1).cookie,
      pendingRevision(transfer),
    );
    expect(accepted.statusCode).toBe(201);
    expect(
      accepted.json<{
        handoff: { status: string; assignedUserId: string | null };
      }>().handoff,
    ).toMatchObject({
      status: "HUMAN_ACTIVE",
      assignedUserId: user(1).userId,
    });
  });

  it("目标客服拒绝后进入 Server2 决定的 fallback queue", async () => {
    const conversationId = await seedOwned("direct-reject");
    const transfer = await transferToUser(conversationId, user(1).userId);
    const rejected = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/reject-transfer`,
      headers: { cookie: user(1).cookie },
      payload: {
        expectedHandoffRevision: pendingRevision(transfer),
        clientRequestId: randomUUID(),
      },
    });
    expect(rejected.statusCode).toBe(201);
    expect(
      rejected.json<{
        handoff: {
          status: string;
          assignedUserId: string | null;
          assignedQueueId: string | null;
        };
      }>().handoff,
    ).toMatchObject({
      status: "HANDOFF_PENDING",
      assignedUserId: null,
      assignedQueueId: "queue-device-fault",
    });
    const state = required(
      (
        await postgres.db
          .select()
          .from(schema.handoffStates)
          .where(eq(schema.handoffStates.conversationId, conversationId))
      )[0],
      "fallback state",
    );
    expect(state.agentPaused).toBe(true);
    expect(state.assignedUserId).toBeNull();

    const timeoutConversationId = await seedOwned("direct-timeout");
    await transferToUser(timeoutConversationId, user(1).userId);
    await postgres.db
      .update(schema.handoffStates)
      .set({ acceptBy: new Date(Date.now() - 1_000) })
      .where(eq(schema.handoffStates.conversationId, timeoutConversationId));
    expect(
      await reconcileExpiredTransfers(postgres.db, timeoutConversationId),
    ).toBe(1);
    const timedOut = required(
      (
        await postgres.db
          .select()
          .from(schema.handoffStates)
          .where(eq(schema.handoffStates.conversationId, timeoutConversationId))
      )[0],
      "timed out transfer",
    );
    expect(timedOut).toMatchObject({
      status: "pending",
      assignedQueueId: "queue-device-fault",
      assignedUserId: null,
      agentPaused: true,
    });
  });

  it("转专业队列后仅合法队列成员可以接手", async () => {
    const conversationId = await seedOwned("queue-transfer");
    const transfer = await transferToQueue(
      conversationId,
      "queue-device-fault",
    );
    expect(transfer.statusCode).toBe(201);
    const revision = pendingRevision(transfer);
    const outsider = await claim(conversationId, user(3).cookie, revision);
    expect(outsider.statusCode).toBe(403);
    const member = await claim(conversationId, user(2).cookie, revision);
    expect(member.statusCode).toBe(201);
    expect(
      member.json<{
        handoff: { status: string; assignedUserId: string | null };
      }>().handoff,
    ).toMatchObject({
      status: "HUMAN_ACTIVE",
      assignedUserId: user(2).userId,
    });
  });

  it("转交确认期间客户补充消息会使旧快照失效", async () => {
    const conversationId = await seedOwned("stale-transfer");
    const preview = await transferPreview(
      conversationId,
      user(0).cookie,
      "user",
      user(1).userId,
    );
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json<{
      context: { sourceConversationRevision: number };
      handoffRevision: number;
    }>();
    await insertCustomerMessage(
      conversationId,
      "客户补充：指示灯现在变红。",
      "stale",
    );
    const stale = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/transfer`,
      headers: { cookie: user(0).cookie },
      payload: {
        targetType: "user",
        targetId: user(1).userId,
        transferReason: "需要设备工程师判断",
        sourceConversationRevision:
          previewBody.context.sourceConversationRevision,
        expectedHandoffRevision: previewBody.handoffRevision,
        clientRequestId: randomUUID(),
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: "conversation_revision_conflict",
    });
  });

  it("结束人工处理后异步生成总结，下一次 Agent 只继承受控结果", async () => {
    const conversationId = await seedOwned("finish-agent");
    const revisionBeforeReply = await conversationRevision(conversationId);
    const reply = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      headers: { cookie: user(0).cookie },
      payload: {
        text: "已确认许可服务未启动，请重启服务后再试。",
        clientRequestId: randomUUID(),
        expectedConversationRevision: revisionBeforeReply,
      },
    });
    expect(reply.statusCode).toBe(202);
    const sentMessageId = reply.json<{ message: { messageId: string } }>()
      .message.messageId;
    const messageReview = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(sentMessageId)}/review-feedback`,
      headers: { cookie: user(0).cookie },
      payload: {
        cycleId: required(
          (
            await postgres.db
              .select({ cycleId: schema.handoffStates.cycleId })
              .from(schema.handoffStates)
              .where(eq(schema.handoffStates.conversationId, conversationId))
          )[0],
          "review cycle",
        ).cycleId,
        clientRequestId: randomUUID(),
      },
    });
    expect(messageReview.statusCode).toBe(201);
    const finish = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/finish`,
      headers: { cookie: user(0).cookie },
      payload: {
        expectedHandoffRevision: await currentRevision(conversationId),
        clientRequestId: randomUUID(),
        result: "resolved_by_human",
      },
    });
    expect(finish.statusCode).toBe(201);
    expect(finish.json<{ handoff: { status: string } }>().handoff.status).toBe(
      "HUMAN_FINISHED",
    );
    const jobBefore = required(
      (
        await postgres.db
          .select()
          .from(schema.handoffResolutionSummaryJobs)
          .where(
            eq(
              schema.handoffResolutionSummaryJobs.conversationId,
              conversationId,
            ),
          )
      )[0],
      "resolution summary job",
    );
    expect(jobBefore.status).toBe("pending");
    expect(await processResolutionSummaryJobs(postgres.db)).toBeGreaterThan(0);
    await insertCustomerMessage(conversationId, "我还有一个后续问题。", "next");
    const context = await buildAgentContext(postgres.db, conversationId);
    expect(context.prompt).toContain("resolved_by_human");
    expect(context.prompt).toContain("许可服务未启动");
    expect(context.prompt).not.toContain(user(0).username);
    expect(context.prompt).not.toContain(user(1).username);
    const state = required(
      (
        await postgres.db
          .select()
          .from(schema.handoffStates)
          .where(eq(schema.handoffStates.conversationId, conversationId))
      )[0],
      "finished state",
    );
    expect(state.agentPaused).toBe(false);
  });

  async function seedHandoff(label: string) {
    const conversationId = `channel:mobile-${label}-${suffix}`;
    const contactId = `contact:mobile-${label}-${suffix}`;
    conversationIds.push(conversationId);
    contactIds.push(contactId);
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `mobile-${label}-${suffix}`,
      channelDisplayName: `客户-${label}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `mobile-${label}-${suffix}`,
    });
    await insertCustomerMessage(
      conversationId,
      "设备更新后无法启动。",
      "initial",
    );
    const result = await createHandoff(postgres.db, {
      conversationId,
      actorUserId: "system-agent",
      clientRequestId: randomUUID(),
      summary: "Agent 无法确认恢复方案",
      sourceIp: "server2",
      briefing: buildHandoffBriefing({
        sourceConversationRevision: await conversationRevision(conversationId),
        handoffReason: "现有知识无法判断是否需要恢复系统。",
        modelBriefing: {
          problemSummary: "设备更新后无法启动",
          unresolvedItems: ["是否能够进入恢复模式"],
          suggestedFirstReply: "方便确认一下当前的电源指示灯状态吗？",
        },
      }),
    });
    expect(result.status).toBe("ok");
    return conversationId;
  }

  async function seedOwned(label: string) {
    const conversationId = await seedHandoff(label);
    const response = await claim(
      conversationId,
      user(0).cookie,
      await currentRevision(conversationId),
    );
    expect(response.statusCode).toBe(201);
    return conversationId;
  }

  async function inbox(cookie: string) {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/mobile/handoffs/inbox?limit=100",
      headers: { cookie },
    });
    if (response.statusCode !== 200) {
      throw new Error(`mobile inbox failed: ${response.body}`);
    }
    return response;
  }

  function inboxItems(response: Awaited<ReturnType<typeof inbox>>) {
    return response.json<{
      items: Array<{
        conversationId: string;
        handoff: { status: string; transferNote?: string | null };
      }>;
    }>().items;
  }

  async function claim(
    conversationId: string,
    cookie: string,
    revision: number,
  ) {
    return server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/accept`,
      headers: { cookie },
      payload: {
        expectedHandoffRevision: revision,
        clientRequestId: randomUUID(),
      },
    });
  }

  async function transferPreview(
    conversationId: string,
    cookie: string,
    targetType: "user" | "queue",
    targetId: string,
  ) {
    return server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/transfer-preview`,
      headers: { cookie },
      payload: { targetType, targetId },
    });
  }

  async function transferToUser(conversationId: string, targetId: string) {
    return transfer(conversationId, "user", targetId);
  }

  async function transferToQueue(conversationId: string, targetId: string) {
    return transfer(conversationId, "queue", targetId);
  }

  async function transfer(
    conversationId: string,
    targetType: "user" | "queue",
    targetId: string,
  ) {
    const preview = await transferPreview(
      conversationId,
      user(0).cookie,
      targetType,
      targetId,
    );
    expect(preview.statusCode).toBe(200);
    const body = preview.json<{
      context: { sourceConversationRevision: number };
      handoffRevision: number;
    }>();
    return server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/transfer`,
      headers: { cookie: user(0).cookie },
      payload: {
        targetType,
        targetId,
        transferReason: "需要更合适的专业能力继续处理",
        sourceConversationRevision: body.context.sourceConversationRevision,
        expectedHandoffRevision: body.handoffRevision,
        clientRequestId: randomUUID(),
      },
    });
  }

  async function insertCustomerMessage(
    conversationId: string,
    text: string,
    label: string,
  ) {
    await postgres.db.insert(schema.messages).values({
      messageId: `mobile-message:${label}:${randomUUID()}`,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text,
      processingState: "received",
      idempotencyKey: `mobile-message:${label}:${randomUUID()}`,
      occurredAt: new Date(),
      traceId: `mobile-message:${label}:${randomUUID()}`,
    });
  }

  async function currentRevision(conversationId: string) {
    const state = required(
      (
        await postgres.db
          .select({ revision: schema.handoffStates.handoffRevision })
          .from(schema.handoffStates)
          .where(eq(schema.handoffStates.conversationId, conversationId))
      )[0],
      "handoff state",
    );
    return state.revision;
  }

  async function conversationRevision(conversationId: string) {
    const conversation = required(
      (
        await postgres.db
          .select({ revision: schema.conversations.revision })
          .from(schema.conversations)
          .where(eq(schema.conversations.conversationId, conversationId))
      )[0],
      "conversation",
    );
    return conversation.revision;
  }

  function pendingRevision(response: Awaited<ReturnType<typeof transfer>>) {
    return response.json<{ handoff: { handoffRevision: number } }>().handoff
      .handoffRevision;
  }

  it("转交说明可选：不带原因也能转交，目标侧留言为空", async () => {
    const conversationId = await seedOwned("optional-note-none");
    const preview = await transferPreview(
      conversationId,
      user(0).cookie,
      "user",
      user(1).userId,
    );
    const previewBody = preview.json<{
      context: { sourceConversationRevision: number };
      handoffRevision: number;
    }>();
    const transferred = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/transfer`,
      headers: { cookie: user(0).cookie },
      payload: {
        targetType: "user",
        targetId: user(1).userId,
        sourceConversationRevision:
          previewBody.context.sourceConversationRevision,
        expectedHandoffRevision: previewBody.handoffRevision,
        clientRequestId: randomUUID(),
        // 不携带 transferReason
      },
    });
    expect(transferred.statusCode).toBe(201);
    const targetItems = inboxItems(await inbox(user(1).cookie));
    const item = targetItems.find(
      (entry) => entry.conversationId === conversationId,
    );
    expect(item?.handoff.status).toBe("TRANSFER_PENDING");
    expect(item?.handoff.transferNote).toBeNull();
    const detail = await server.inject({
      method: "GET",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff`,
      headers: { cookie: user(1).cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(
      detail.json<{ handoff: { activeTransferNote: string | null } }>().handoff
        .activeTransferNote,
    ).toBeNull();
  });

  it("转交说明传递：目标客服可在收件箱与详情读到留言", async () => {
    const conversationId = await seedOwned("optional-note-filled");
    const preview = await transferPreview(
      conversationId,
      user(0).cookie,
      "user",
      user(1).userId,
    );
    const previewBody = preview.json<{
      context: { sourceConversationRevision: number };
      handoffRevision: number;
    }>();
    const transferred = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/transfer`,
      headers: { cookie: user(0).cookie },
      payload: {
        targetType: "user",
        targetId: user(1).userId,
        transferReason: "请确认客户当前固件版本",
        sourceConversationRevision:
          previewBody.context.sourceConversationRevision,
        expectedHandoffRevision: previewBody.handoffRevision,
        clientRequestId: randomUUID(),
      },
    });
    expect(transferred.statusCode).toBe(201);
    const targetItems = inboxItems(await inbox(user(1).cookie));
    const item = targetItems.find(
      (entry) => entry.conversationId === conversationId,
    );
    expect(item?.handoff.transferNote).toBe("请确认客户当前固件版本");
    const detail = await server.inject({
      method: "GET",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff`,
      headers: { cookie: user(1).cookie },
    });
    const body = detail.json<{
      handoff: {
        activeTransferNote: string | null;
        cycles: Array<{
          transferContext: { transferReason: string } | null;
        }>;
      };
    }>().handoff;
    expect(body.activeTransferNote).toBe("请确认客户当前固件版本");
    const currentCycle = body.cycles[body.cycles.length - 1];
    expect(currentCycle?.transferContext?.transferReason).toBe(
      "请确认客户当前固件版本",
    );
  });

  it("联系人历史：按 contactId 过滤返回该联系人全部会话", async () => {
    const contactId = `contact:mobile-history-${suffix}`;
    const firstConversationId = `channel:mobile-history-a-${suffix}`;
    const secondConversationId = `channel:mobile-history-b-${suffix}`;
    const otherContactId = `contact:mobile-history-other-${suffix}`;
    const otherConversationId = `channel:mobile-history-other-${suffix}`;
    conversationIds.push(
      firstConversationId,
      secondConversationId,
      otherConversationId,
    );
    contactIds.push(contactId, otherContactId);
    await postgres.db.insert(schema.contactProfiles).values([
      {
        contactId,
        channel: "channel",
        channelContactId: `mobile-history-${suffix}`,
        channelDisplayName: "历史客户",
      },
      {
        contactId: otherContactId,
        channel: "channel",
        channelContactId: `mobile-history-other-${suffix}`,
        channelDisplayName: "其他客户",
      },
    ]);
    await postgres.db.insert(schema.conversations).values([
      {
        conversationId: firstConversationId,
        contactId,
        channel: "channel",
        channelConversationId: `mobile-history-a-${suffix}`,
      },
      {
        conversationId: secondConversationId,
        contactId,
        channel: "channel",
        channelConversationId: `mobile-history-b-${suffix}`,
      },
      {
        conversationId: otherConversationId,
        contactId: otherContactId,
        channel: "channel",
        channelConversationId: `mobile-history-other-${suffix}`,
      },
    ]);
    await insertCustomerMessage(firstConversationId, "第一次咨询", "hist-a");
    await insertCustomerMessage(secondConversationId, "第二次咨询", "hist-b");
    await insertCustomerMessage(otherConversationId, "别的客户", "hist-other");
    const filtered = await server.inject({
      method: "GET",
      url: `/api/v1/conversations?limit=50&contactId=${encodeURIComponent(contactId)}`,
      headers: { cookie: user(0).cookie },
    });
    expect(filtered.statusCode).toBe(200);
    const conversations = filtered.json<{
      conversations: Array<{ conversationId: string }>;
    }>().conversations;
    const ids = conversations.map((entry) => entry.conversationId);
    expect(ids).toContain(firstConversationId);
    expect(ids).toContain(secondConversationId);
    expect(ids).not.toContain(otherConversationId);
  });

  it("联系人历史：正式端点游标分页无漏无重且包含全部类型会话", async () => {
    const contactId = `contact:mobile-history-cursor-${suffix}`;
    const ids: string[] = [];
    contactIds.push(contactId);
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `mobile-history-cursor-${suffix}`,
      channelDisplayName: "分页客户",
    });
    // 5 个会话，时间错开；第 5 个额外建 Handoff
    for (let index = 0; index < 5; index += 1) {
      const conversationId = `channel:mobile-history-cursor-${suffix}-${String(index)}`;
      ids.push(conversationId);
      conversationIds.push(conversationId);
      await postgres.db.insert(schema.conversations).values({
        conversationId,
        contactId,
        channel: "channel",
        channelConversationId: `cursor-${String(index)}-${suffix}`,
      });
      await postgres.db.insert(schema.messages).values({
        messageId: `cursor-msg-${String(index)}-${suffix}`,
        conversationId,
        direction: "inbound",
        actorType: "channel_contact",
        contentType: "text",
        channelType: 1,
        text: `第 ${String(index)} 次咨询`,
        processingState: "received",
        idempotencyKey: `cursor-idem-${String(index)}-${suffix}`,
        occurredAt: new Date(Date.now() - (5 - index) * 60_000),
        traceId: `cursor-trace-${suffix}`,
      });
    }
    // 第 5 个会话有一个已结束 Handoff（跨 Handoff 全量）
    await createHandoff(postgres.db, {
      conversationId: required(ids[4], "history conversation"),
      actorUserId: "system-agent",
      clientRequestId: randomUUID(),
      summary: "cursor handoff",
      sourceIp: "server2",
      briefing: buildHandoffBriefing({
        sourceConversationRevision: 0,
        handoffReason: "cursor test",
      }),
    });

    const collected: string[] = [];
    let before: string | undefined;
    for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
      const url = `/api/v1/contacts/${encodeURIComponent(contactId)}/conversations?limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`;
      const response = await server.inject({
        method: "GET",
        url,
        headers: { cookie: user(0).cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        conversations: Array<{
          conversationId: string;
          latestMessageText: string;
          handoffStatus: string | null;
        }>;
        nextCursor: string | null;
      }>();
      for (const item of body.conversations) {
        collected.push(item.conversationId);
      }
      if (!body.nextCursor) break;
      before = body.nextCursor;
    }
    expect(collected).toHaveLength(5);
    // 无重复
    expect(new Set(collected).size).toBe(5);
    // 时间倒序（第 4 次咨询最新）
    expect(collected[0]).toBe(ids[4]);
    expect(collected[4]).toBe(ids[0]);
    // 最后一个会话（ids[4]）带 handoff 状态（已有 Handoff 记录）
    const detail = await server.inject({
      method: "GET",
      url: `/api/v1/contacts/${encodeURIComponent(contactId)}/conversations?limit=1`,
      headers: { cookie: user(0).cookie },
    });
    const first = detail.json<{
      conversations: Array<{ handoffStatus: string | null }>;
    }>().conversations[0];
    expect(first?.handoffStatus).not.toBeNull();
  });

  it("结束态后可重新接管：resolve 后 take-over 开启新 cycle", async () => {
    const conversationId = await seedOwned("re-takeover");

    const resolveResponse = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/resolve`,
      headers: { cookie: user(0).cookie },
      payload: {
        summary: "首次处理完毕",
        clientRequestId: randomUUID(),
      },
    });
    expect(resolveResponse.statusCode, resolveResponse.body).toBe(201);
    const resolvedState = required(
      (
        await postgres.db
          .select()
          .from(schema.handoffStates)
          .where(eq(schema.handoffStates.conversationId, conversationId))
      )[0],
      "handoff state after resolve",
    );
    expect(resolvedState.status).toBe("resolved");
    expect(resolvedState.agentPaused).toBe(false);

    const takeoverResponse = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/take-over`,
      headers: { cookie: user(1).cookie },
      payload: {
        summary: "二次跟进",
        clientRequestId: randomUUID(),
      },
    });
    expect(takeoverResponse.statusCode, takeoverResponse.body).toBe(201);
    const newCycleState = required(
      (
        await postgres.db
          .select()
          .from(schema.handoffStates)
          .where(eq(schema.handoffStates.conversationId, conversationId))
      )[0],
      "handoff state after re-takeover",
    );
    expect(newCycleState.status).toBe("in_progress");
    expect(newCycleState.assignedUserId).toBe(user(1).userId);
    expect(newCycleState.agentPaused).toBe(true);

    const cycles = await postgres.db
      .select()
      .from(schema.handoffCycles)
      .where(eq(schema.handoffCycles.conversationId, conversationId));
    expect(cycles.length).toBeGreaterThanOrEqual(2);
  });
});

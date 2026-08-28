import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { buildHandoffBriefing } from "../modules/handoff/application/handoff-briefing.js";
import { createHandoff } from "../modules/handoff/application/handoff-service.js";
import {
  claimMobileHandoff,
  listMobileHandoffInbox,
  reconcileUnclaimedQueuedHandoffs,
} from "../modules/handoff/application/mobile-handoff-service.js";
import { updateProfile } from "../modules/identity/application/identity-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("转人工按标签定向路由（tag-based routing）", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const taggedUserId = randomUUID();
  const memberUserId = randomUUID();
  const plainUserId = randomUUID();
  const conversationIds: string[] = [];
  const contactIds: string[] = [];
  let taggedUser = "";
  let memberUser = "";
  let plainUser = "";

  async function seedUser(userId: string, label: string) {
    const username = `tag-${label}-${suffix}`;
    await postgres.db.insert(schema.users).values({
      userId,
      username,
      passwordHash: "unused-in-test",
      role: "operator",
      mustChangePassword: false,
      status: "active",
    });
    return username;
  }

  async function seedRoutedHandoff(label: string) {
    const conversationId = `channel:tag-${label}-${suffix}`;
    const contactId = `contact:tag-${label}-${suffix}`;
    conversationIds.push(conversationId);
    contactIds.push(contactId);
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `tag-${label}-${suffix}`,
      channelDisplayName: `客户-${label}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `tag-${label}-${suffix}`,
    });
    const result = await createHandoff(postgres.db, {
      conversationId,
      actorUserId: "system-agent",
      clientRequestId: randomUUID(),
      summary: "agent_recommended: device_troubleshooting/answering",
      sourceIp: "server2",
      assignedQueueId: "queue-device-fault",
      briefing: buildHandoffBriefing({
        sourceConversationRevision: 1,
        handoffReason: "设备故障需人工判断",
      }),
    });
    if (result.status !== "ok") throw new Error("seed handoff failed");
    return conversationId;
  }

  async function inboxItems(actorUserId: string) {
    const items = await listMobileHandoffInbox(postgres.db, actorUserId, 100);
    return items.map((item) => item.conversationId);
  }

  async function notificationsFor(conversationId: string) {
    const rows = await postgres.db
      .select({ userId: schema.notificationOutbox.userId })
      .from(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.conversationId, conversationId));
    return rows.map((row) => row.userId);
  }

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "tag-routing-test"),
    );
    // 直接插入用户行以控制 userId 与无密码状态（服务逻辑不依赖登录态）
    await seedUser(taggedUserId, "tagged");
    await seedUser(memberUserId, "member");
    await seedUser(plainUserId, "plain");
    // tagged：名片标签 device_fault；member：协作队列成员；plain：无任何匹配
    const tagged = await updateProfile(
      postgres.db,
      taggedUserId,
      { displayName: "设备小王", tags: ["device_fault"] },
      "test",
    );
    if (tagged.status !== "ok") throw new Error("tag profile failed");
    await postgres.db.insert(schema.queueMembers).values({
      membershipId: randomUUID(),
      queueId: "queue-device-fault",
      userId: memberUserId,
    });
    taggedUser = taggedUserId;
    memberUser = memberUserId;
    plainUser = plainUserId;
  });

  afterAll(async () => {
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
      .delete(schema.messages)
      .where(inArray(schema.messages.conversationId, conversationIds));
    await postgres.db
      .delete(schema.conversations)
      .where(inArray(schema.conversations.conversationId, conversationIds));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(inArray(schema.contactProfiles.contactId, contactIds));
    await postgres.db
      .delete(schema.queueMembers)
      .where(
        inArray(schema.queueMembers.userId, [
          taggedUserId,
          memberUserId,
          plainUserId,
        ]),
      );
    await postgres.db
      .delete(schema.auditEvents)
      .where(
        inArray(schema.auditEvents.actorUserId, [
          taggedUserId,
          memberUserId,
          plainUserId,
        ]),
      );
    await postgres.db
      .delete(schema.users)
      .where(
        inArray(schema.users.userId, [taggedUserId, memberUserId, plainUserId]),
      );
    await postgres.close();
  });

  it("定向创建后：持标签与队列成员可见，无关客服不可见", async () => {
    const conversationId = await seedRoutedHandoff("visible");
    const taggedItems = await inboxItems(taggedUser);
    const memberItems = await inboxItems(memberUser);
    const plainItems = await inboxItems(plainUser);
    expect(taggedItems).toContain(conversationId);
    expect(memberItems).toContain(conversationId);
    expect(plainItems).not.toContain(conversationId);
  });

  it("待认领通知只发给持标签与队列成员", async () => {
    const conversationId = await seedRoutedHandoff("notify");
    const notified = await notificationsFor(conversationId);
    expect(notified).toContain(taggedUser);
    expect(notified).toContain(memberUser);
    expect(notified).not.toContain(plainUser);
  });

  it("持标签客服可以认领，无关客服被拒绝", async () => {
    const conversationId = await seedRoutedHandoff("claim");
    const state = (
      await postgres.db
        .select()
        .from(schema.handoffStates)
        .where(eq(schema.handoffStates.conversationId, conversationId))
    )[0];
    if (!state) throw new Error("missing state");
    const revision = state.handoffRevision;
    const claimed = await claimMobileHandoff(postgres.db, {
      conversationId,
      actorUserId: taggedUser,
      expectedHandoffRevision: revision,
      clientRequestId: randomUUID(),
      sourceIp: "test",
    });
    expect(claimed.status).toBe("ok");

    const secondId = await seedRoutedHandoff("claim-denied");
    const secondState = (
      await postgres.db
        .select()
        .from(schema.handoffStates)
        .where(eq(schema.handoffStates.conversationId, secondId))
    )[0];
    const denied = await claimMobileHandoff(postgres.db, {
      conversationId: secondId,
      actorUserId: plainUser,
      expectedHandoffRevision: secondState?.handoffRevision ?? 0,
      clientRequestId: randomUUID(),
      sourceIp: "test",
    });
    expect(denied.status).toBe("not_eligible");
  });

  it("超时无人认领回落到通用队列：解除限制、全员可见、重发通知", async () => {
    const conversationId = await seedRoutedHandoff("escalate");
    // 回拨 pendingSince 模拟超过 15 分钟无人认领
    await postgres.db
      .update(schema.handoffStates)
      .set({ pendingSince: new Date(Date.now() - 16 * 60 * 1_000) })
      .where(eq(schema.handoffStates.conversationId, conversationId));
    const escalated = await reconcileUnclaimedQueuedHandoffs(postgres.db);
    expect(escalated).toBe(1);
    const [state] = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId));
    expect(state?.assignedQueueId).toBeNull();
    const plainItems = await inboxItems(plainUser);
    expect(plainItems).toContain(conversationId);
    const notified = await notificationsFor(conversationId);
    expect(notified).toContain(plainUser);
  });

  it("未到时限的定向任务不被兜底提前解除", async () => {
    const conversationId = await seedRoutedHandoff("not-yet");
    const escalated = await reconcileUnclaimedQueuedHandoffs(postgres.db);
    expect(escalated).toBe(0);
    const [state] = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, conversationId));
    expect(state?.assignedQueueId).toBe("queue-device-fault");
  });
});

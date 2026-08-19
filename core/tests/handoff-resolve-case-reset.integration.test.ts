/**
 * Phase 8 回归测试：人工结束后必须重置 Case 状态
 *
 * 缺陷：requiresHuman=true + stage=handoff 卡死在 case_states，
 * Agent 接续时上下文始终是"需要人工"，导致无限转人工。
 * 修复：v1/v2 人工结束路径清除 requiresHuman 并把 stage 从 handoff 复位为 answering。
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import {
  acceptHandoff,
  createHandoff,
  resolveHandoff,
} from "../modules/handoff/application/handoff-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const logger = createLogger({ logLevel: "silent" }, "case-reset-test");

integration("handoff resolve resets case state（防无限转人工）", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const eventBase = `case-reset-${suffix}`;
  const created: { conversationId: string; contactId: string }[] = [];

  beforeAll(() => {
    postgres = createPostgres(databaseUrl ?? "", logger);
  });

  afterAll(async () => {
    for (const { conversationId, contactId } of created) {
      await postgres.db
        .delete(schema.agentTurns)
        .where(eq(schema.agentTurns.conversationId, conversationId));
      await postgres.db
        .delete(schema.caseStates)
        .where(eq(schema.caseStates.conversationId, conversationId));
      await postgres.db
        .delete(schema.memoryCaptureStates)
        .where(eq(schema.memoryCaptureStates.conversationId, conversationId));
      await postgres.db
        .delete(schema.handoffStates)
        .where(eq(schema.handoffStates.conversationId, conversationId));
      await postgres.db
        .delete(schema.handoffEvents)
        .where(eq(schema.handoffEvents.conversationId, conversationId));
      await postgres.db
        .delete(schema.handoffCycles)
        .where(eq(schema.handoffCycles.conversationId, conversationId));
      await postgres.db
        .delete(schema.notificationOutbox)
        .where(eq(schema.notificationOutbox.conversationId, conversationId));
      await postgres.db
        .delete(schema.messages)
        .where(eq(schema.messages.conversationId, conversationId));
      await postgres.db
        .delete(schema.conversations)
        .where(eq(schema.conversations.conversationId, conversationId));
      await postgres.db
        .delete(schema.contactProfiles)
        .where(eq(schema.contactProfiles.contactId, contactId));
    }
    await postgres.close();
  });

  it("人工结束（v1 resolve）后 case 状态从 handoff 复位", async () => {
    const eventId = `${eventBase}-event`;
    const sourceConversationId = eventBase;
    const conversationId = `channel:${sourceConversationId}`;
    await ingestChannelEvents(
      postgres.db,
      [
        {
          cursor: "1",
          eventId,
          conversationRef: sourceConversationId,
          channelMessageId: `channel-${eventId}`,
          senderRef: "wxid_friend",
          kind: "text",
          content: "你好",
          occurredAt: "2026-08-17T00:00:00.000Z",
          observedAt: "2026-08-17T00:00:01.000Z",
          isSelf: false,
        },
      ],
      "1",
    );
    const [conversation] = await postgres.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId))
      .limit(1);
    if (!conversation) throw new Error("conversation missing");
    created.push({ conversationId, contactId: conversation.contactId });

    // 模拟卡死状态：stage=handoff + requiresHuman=true
    await postgres.db.insert(schema.caseStates).values({
      conversationId,
      revision: 1,
      intent: "device_troubleshooting",
      stage: "handoff",
      knownFields: {},
      missingFields: [],
      askedFields: [],
      actionHistory: [],
      requiresHuman: true,
      riskLevel: "medium",
      updatedAt: new Date(),
    });

    // 完整走一遍 转人工 → 接管 → 结束
    const actor = "test-actor";
    const create = await createHandoff(postgres.db, {
      conversationId,
      actorUserId: "system",
      clientRequestId: randomUUID(),
      summary: "test handoff",
      sourceIp: "127.0.0.1",
    });
    expect(create.status).toBe("ok");
    const accept = await acceptHandoff(postgres.db, {
      conversationId,
      actorUserId: actor,
      clientRequestId: randomUUID(),
      summary: "test accept",
      sourceIp: "127.0.0.1",
    });
    expect(accept.status).toBe("ok");
    const resolve = await resolveHandoff(postgres.db, {
      conversationId,
      actorUserId: actor,
      clientRequestId: randomUUID(),
      summary: "test resolve",
      sourceIp: "127.0.0.1",
    });
    expect(resolve.status).toBe("ok");

    const [caseState] = await postgres.db
      .select()
      .from(schema.caseStates)
      .where(eq(schema.caseStates.conversationId, conversationId))
      .limit(1);
    if (!caseState) throw new Error("case state missing");
    expect(caseState.requiresHuman).toBe(false);
    expect(caseState.stage).toBe("answering");
  });
});

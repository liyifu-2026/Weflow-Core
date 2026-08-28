import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { getManualReplyOutcome } from "../modules/conversations/application/create-manual-reply.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("message outcome by stable id", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const contactId = `contact:msg-outcome-${suffix}`;
  const conversationId = `channel:msg-outcome-${suffix}`;

  const agentMessageId = `agent-message:turn:${suffix}:1`;
  const manualMessageId = `manual-message:${"a".repeat(64)}`;
  const manualClientRequestId = randomUUID();

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "msg-outcome-test"),
    );
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `msg-outcome-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `msg-outcome-${suffix}`,
    });

    const base = {
      conversationId,
      channelEventId: null,
      channelMessageId: null,
      direction: "outbound" as const,
      contentType: "text" as const,
      channelType: 1,
      text: "测试消息",
      isSelf: true,
      processingState: "not_applicable" as const,
    };

    await postgres.db.insert(schema.messages).values([
      {
        ...base,
        messageId: agentMessageId,
        actorType: "agent",
        actorId: null,
        sendState: "sent",
        replyBatchId: `agent-reply:turn:${suffix}`,
        replySequence: 1,
        idempotencyKey: agentMessageId,
        occurredAt: new Date(),
        traceId: `trace:${suffix}`,
      },
      {
        ...base,
        messageId: manualMessageId,
        actorType: "user",
        actorId: "user-admin",
        sendState: "failed",
        replyBatchId: null,
        replySequence: null,
        idempotencyKey: `manual:${manualClientRequestId}`,
        occurredAt: new Date(),
        traceId: `trace:${suffix}:manual`,
      },
    ]);
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, contactId));
    await postgres.close();
  });

  it("resolves an agent message outcome by its agent-message messageId", async () => {
    const outcome = await getManualReplyOutcome(postgres.db, {
      conversationId,
      clientRequestId: agentMessageId,
    });
    expect(outcome.status).toBe("sent");
    if (outcome.status !== "not_found") {
      expect(outcome.message.messageId).toBe(agentMessageId);
    }
  });

  it("resolves a manual message outcome by its manual-message messageId", async () => {
    const outcome = await getManualReplyOutcome(postgres.db, {
      conversationId,
      clientRequestId: manualMessageId,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "not_found") {
      expect(outcome.message.messageId).toBe(manualMessageId);
    }
  });

  it("keeps resolving a manual message by its original clientRequestId (UUID)", async () => {
    const outcome = await getManualReplyOutcome(postgres.db, {
      conversationId,
      clientRequestId: manualClientRequestId,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "not_found") {
      expect(outcome.message.messageId).toBe(manualMessageId);
    }
  });

  it("returns not_found for an unknown id", async () => {
    const outcome = await getManualReplyOutcome(postgres.db, {
      conversationId,
      clientRequestId: `agent-message:turn:${suffix}:does-not-exist`,
    });
    expect(outcome.status).toBe("not_found");
  });
});

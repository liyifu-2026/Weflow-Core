import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { createAgentReply } from "../modules/conversations/application/message-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("agent reply MessageService", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const contactId = `contact:message-service-${suffix}`;
  const conversationId = `channel:message-service-${suffix}`;

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "message-service-test"),
    );
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `message-service-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `message-service-${suffix}`,
    });
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

  it("creates a normal Agent reply batch with the existing message invariants", async () => {
    const result = await createAgentReply(postgres.db, {
      conversationId,
      turnId: `turn:${suffix}:normal`,
      traceId: `trace:${suffix}:normal`,
      segments: ["第一段", "第二段"],
      variant: "direct",
    });

    expect(result.created).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(result.messages).toMatchObject([
      {
        conversationId,
        direction: "outbound",
        actorType: "agent",
        contentType: "text",
        channelType: 1,
        isSelf: true,
        processingState: "not_applicable",
        sendState: "pending",
        replyBatchId: `agent-reply:turn:${suffix}:normal`,
        replySequence: 1,
        idempotencyKey: `agent-message:turn:${suffix}:normal:1`,
        traceId: `trace:${suffix}:normal`,
      },
      {
        conversationId,
        direction: "outbound",
        actorType: "agent",
        contentType: "text",
        channelType: 1,
        isSelf: true,
        processingState: "not_applicable",
        sendState: "pending",
        replyBatchId: `agent-reply:turn:${suffix}:normal`,
        replySequence: 2,
        idempotencyKey: `agent-message:turn:${suffix}:normal:2`,
        traceId: `trace:${suffix}:normal`,
      },
    ]);
  });

  it("replays the same deterministic Agent reply without creating duplicates", async () => {
    const input = {
      conversationId,
      turnId: `turn:${suffix}:idempotent`,
      traceId: `trace:${suffix}:idempotent`,
      segments: ["可重放"],
      variant: "direct" as const,
    };

    const first = await createAgentReply(postgres.db, input);
    const second = await createAgentReply(postgres.db, input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const rows = await postgres.db
      .select({ messageId: schema.messages.messageId })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          eq(schema.messages.replyBatchId, `agent-reply:${input.turnId}`),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("rejects reuse of a deterministic reply identity with different content", async () => {
    const input = {
      conversationId,
      turnId: `turn:${suffix}:conflict`,
      traceId: `trace:${suffix}:conflict`,
      segments: ["原始内容"],
      variant: "direct" as const,
    };

    await createAgentReply(postgres.db, input);

    await expect(
      createAgentReply(postgres.db, { ...input, segments: ["不同内容"] }),
    ).rejects.toThrow("agent_reply_idempotency_conflict");
  });

  it("keeps tool-result reply batch identity and sequence semantics", async () => {
    const result = await createAgentReply(postgres.db, {
      conversationId,
      turnId: `turn:${suffix}:tool`,
      traceId: `trace:${suffix}:tool`,
      segments: ["工具结果"],
      variant: "tool_result",
    });

    expect(result.messages[0]).toMatchObject({
      messageId: `agent-message:turn:${suffix}:tool:tool-result:1`,
      replyBatchId: `agent-reply:turn:${suffix}:tool:tool-result`,
      replySequence: 1,
      idempotencyKey: `agent-message:turn:${suffix}:tool:tool-result:1`,
    });
  });

  it("rolls back Agent reply messages with the caller transaction", async () => {
    const turnId = `turn:${suffix}:rollback`;
    await expect(
      postgres.db.transaction(async (transaction) => {
        await createAgentReply(transaction, {
          conversationId,
          turnId,
          traceId: `trace:${suffix}:rollback`,
          segments: ["事务内回复"],
          variant: "direct",
        });
        throw new Error("rollback test");
      }),
    ).rejects.toThrow("rollback test");

    const rows = await postgres.db
      .select({ messageId: schema.messages.messageId })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    expect(rows.some((row) => row.messageId.includes(turnId))).toBe(false);
  });
});

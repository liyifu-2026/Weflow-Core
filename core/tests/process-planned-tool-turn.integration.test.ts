import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { processPlannedToolTurn } from "../modules/agent/application/process-planned-tool-turn.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("planned tool turn recovery", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationId = `channel:planned-tool-retry-${suffix}`;
  const contactId = `contact:channel:planned-tool-retry-${suffix}`;
  const messageId = `planned-tool-message-${suffix}`;
  const turnId = `planned-tool-turn-${suffix}`;
  const executionId = `agent-tool:${turnId}`;

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "planned-tool-retry-test"),
    );
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `planned-tool-retry-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `planned-tool-retry-${suffix}`,
    });
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text: "软件打不开",
      processingState: "received",
      idempotencyKey: messageId,
      occurredAt: new Date(),
      traceId: messageId,
    });
    await postgres.db.insert(schema.agentTurns).values({
      turnId,
      triggerMessageId: messageId,
      conversationId,
      status: "tool_planned",
      traceId: turnId,
    });
    await postgres.db.insert(schema.toolExecutions).values({
      executionId,
      turnId,
      conversationId,
      toolName: "query_contact_profile",
      status: "planned",
      idempotencyKey: executionId,
      arguments: {},
    });
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(eq(schema.memoryCaptureStates.conversationId, conversationId));
    await postgres.db
      .delete(schema.toolExecutions)
      .where(eq(schema.toolExecutions.executionId, executionId));
    await postgres.db
      .delete(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId));
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

  it("reuses a succeeded tool result after the final model response fails", async () => {
    const emptyResponseClient = new OpenAiCompatibleClient({
      baseUrl: "https://model.invalid",
      apiKey: "test-only",
      model: "test",
      timeoutMs: 1_000,
      fetch: () =>
        Promise.resolve(
          Response.json({ choices: [{ message: { content: "" } }] }),
        ),
    });
    await expect(
      processPlannedToolTurn(
        postgres.db,
        emptyResponseClient,
        "test",
        turnId,
        turnId,
      ),
    ).rejects.toThrow("model API returned an empty response");

    const response = JSON.stringify({
      reply_segments: ["请提供软件版本和报错截图，我来帮您排查。"],
      next_action: "ask_for_information",
      requires_human: false,
      risk_level: "low",
    });
    const successClient = new OpenAiCompatibleClient({
      baseUrl: "https://model.invalid",
      apiKey: "test-only",
      model: "test",
      timeoutMs: 1_000,
      fetch: () =>
        Promise.resolve(
          Response.json({ choices: [{ message: { content: response } }] }),
        ),
    });
    await processPlannedToolTurn(
      postgres.db,
      successClient,
      "test",
      turnId,
      turnId,
    );

    const turns = await postgres.db
      .select({ status: schema.agentTurns.status })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId));
    expect(turns[0]).toEqual({ status: "completed" });
  });
});

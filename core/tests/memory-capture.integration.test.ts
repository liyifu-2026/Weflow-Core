import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { processMemoryCapture } from "../modules/memory/application/process-memory-capture.js";
import { recallMemories } from "../modules/memory/application/recall-memories.js";
import { scheduleMemoryCapture } from "../modules/memory/application/schedule-memory-capture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("automatic memory capture", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const contactId = `contact:memory:${suffix}`;
  const conversationId = `channel:memory-${suffix}`;
  const firstMessageId = `memory-message-1:${suffix}`;
  const secondMessageId = `memory-message-2:${suffix}`;
  const thirdMessageId = `memory-message-3:${suffix}`;

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "memory-capture-test"),
    );
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `memory-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `memory-${suffix}`,
    });
    await postgres.db.insert(schema.messages).values({
      messageId: firstMessageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      actorId: contactId,
      contentType: "text",
      channelType: 1,
      text: "以后叫我 Leaif，我的健康信息不要自动记录。",
      processingState: "received",
      idempotencyKey: firstMessageId,
      occurredAt: new Date(),
      traceId: firstMessageId,
    });
  });

  afterAll(async () => {
    const ownedMemories = await postgres.db
      .select({ memoryId: schema.memories.memoryId })
      .from(schema.memories)
      .where(eq(schema.memories.contactId, contactId));
    for (const memory of ownedMemories) {
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
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, contactId));
    await postgres.close();
  });

  it("publishes safe memories, keeps sensitive candidates and supersedes conflicts", async () => {
    const modelResponses = [
      {
        memories: [
          {
            kind: "preference",
            key: "preferred_name",
            content: "Leaif",
            confidence: 98,
            evidenceMessageIds: [firstMessageId],
            subject: "contact",
            explicit: true,
            stable: true,
            sensitive: false,
          },
          {
            kind: "fact",
            key: "health",
            content: "健康相关信息",
            confidence: 99,
            evidenceMessageIds: [firstMessageId],
            subject: "contact",
            explicit: true,
            stable: true,
            sensitive: true,
          },
          {
            kind: "fact",
            key: "invalid_evidence",
            content: "must be rejected",
            confidence: 100,
            evidenceMessageIds: ["not-in-window"],
            subject: "contact",
            explicit: true,
            stable: true,
            sensitive: false,
          },
        ],
      },
      {
        memories: [
          {
            kind: "preference",
            key: "preferred_name",
            content: "小叶",
            confidence: 97,
            evidenceMessageIds: [secondMessageId],
            subject: "contact",
            explicit: true,
            stable: true,
            sensitive: false,
          },
        ],
      },
    ];
    let modelCalls = 0;
    const client = new OpenAiCompatibleClient({
      baseUrl: "https://model.invalid",
      apiKey: "test",
      model: "deepseek-v4-flash",
      timeoutMs: 1_000,
      fetch: () => {
        const content = JSON.stringify(modelResponses[modelCalls]);
        modelCalls += 1;
        return Promise.resolve(
          Response.json({ choices: [{ message: { content } }] }),
        );
      },
    });
    const due = new Date(Date.now() - 100_000);
    await scheduleMemoryCapture(postgres.db, {
      conversationId,
      contactId,
      watermarkMessageId: firstMessageId,
      now: due,
    });
    await expect(
      processMemoryCapture(postgres.db, client, "deepseek-v4-flash", {
        conversationId,
        revision: 1,
      }),
    ).resolves.toBe("completed");
    await expect(
      processMemoryCapture(postgres.db, client, "deepseek-v4-flash", {
        conversationId,
        revision: 1,
      }),
    ).resolves.toBe("stale");
    expect(modelCalls).toBe(1);

    const firstMemories = await postgres.db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.contactId, contactId));
    expect(firstMemories).toHaveLength(2);
    expect(firstMemories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memoryKey: "preferred_name",
          content: "Leaif",
          status: "active",
        }),
        expect.objectContaining({
          memoryKey: "health",
          status: "candidate",
        }),
      ]),
    );
    expect(await recallMemories(postgres.db, conversationId)).toEqual([
      expect.objectContaining({ content: "Leaif" }),
    ]);

    await postgres.db.insert(schema.messages).values({
      messageId: secondMessageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      actorId: contactId,
      contentType: "text",
      channelType: 1,
      text: "以后改叫我小叶。",
      processingState: "received",
      idempotencyKey: secondMessageId,
      occurredAt: new Date(),
      traceId: secondMessageId,
    });
    await scheduleMemoryCapture(postgres.db, {
      conversationId,
      contactId,
      watermarkMessageId: secondMessageId,
      now: due,
    });
    await expect(
      processMemoryCapture(postgres.db, client, "deepseek-v4-flash", {
        conversationId,
        revision: 2,
      }),
    ).resolves.toBe("completed");
    expect(await recallMemories(postgres.db, conversationId)).toEqual([
      expect.objectContaining({ content: "小叶" }),
    ]);
    const old = await postgres.db
      .select()
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.contactId, contactId),
          eq(schema.memories.content, "Leaif"),
        ),
      );
    expect(old[0]).toMatchObject({ status: "superseded" });

    await postgres.db.insert(schema.messages).values({
      messageId: thirdMessageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      actorId: contactId,
      contentType: "text",
      channelType: 1,
      text: "我喜欢乌龙茶。",
      processingState: "received",
      idempotencyKey: thirdMessageId,
      occurredAt: new Date(),
      traceId: thirdMessageId,
    });
    await scheduleMemoryCapture(postgres.db, {
      conversationId,
      contactId,
      watermarkMessageId: thirdMessageId,
      now: due,
    });
    let releaseModel: (response: Response) => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const staleClient = new OpenAiCompatibleClient({
      baseUrl: "https://model.invalid",
      apiKey: "test",
      model: "deepseek-v4-flash",
      timeoutMs: 1_000,
      fetch: () => {
        markStarted();
        return new Promise<Response>((resolve) => {
          releaseModel = resolve;
        });
      },
    });
    const staleCapture = processMemoryCapture(
      postgres.db,
      staleClient,
      "deepseek-v4-flash",
      { conversationId, revision: 3 },
    );
    await started;
    await scheduleMemoryCapture(postgres.db, {
      conversationId,
      contactId,
      watermarkMessageId: thirdMessageId,
      now: due,
    });
    releaseModel(
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                memories: [
                  {
                    kind: "preference",
                    key: "tea",
                    content: "乌龙茶",
                    confidence: 99,
                    evidenceMessageIds: [thirdMessageId],
                    subject: "contact",
                    explicit: true,
                    stable: true,
                    sensitive: false,
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
    await expect(staleCapture).resolves.toBe("stale");
    const staleMemory = await postgres.db
      .select()
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.contactId, contactId),
          eq(schema.memories.content, "乌龙茶"),
        ),
      );
    expect(staleMemory).toHaveLength(0);
  });

  it("persists progress and continues when an idle window exceeds one batch", async () => {
    const batchContactId = `${contactId}:batch`;
    const batchConversationId = `${conversationId}:batch`;
    const messages = Array.from({ length: 41 }, (_, index) => ({
      messageId: `batch-message-${String(index).padStart(3, "0")}:${suffix}`,
      conversationId: batchConversationId,
      direction: "inbound",
      actorType: "channel_contact",
      actorId: batchContactId,
      contentType: "text",
      channelType: 1,
      text: `message ${String(index)}`,
      processingState: "received",
      idempotencyKey: `batch-message-${String(index)}:${suffix}`,
      occurredAt: new Date(1_700_000_000_000 + index * 1_000),
      createdAt: new Date(1_700_000_000_000 + index * 1_000),
      traceId: `batch-message-${String(index)}:${suffix}`,
    }));
    await postgres.db.insert(schema.contactProfiles).values({
      contactId: batchContactId,
      channel: "channel",
      channelContactId: `memory-batch-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId: batchConversationId,
      contactId: batchContactId,
      channel: "channel",
      channelConversationId: `memory-batch-${suffix}`,
    });
    await postgres.db.insert(schema.messages).values(messages);
    const due = new Date(Date.now() - 100_000);
    await scheduleMemoryCapture(postgres.db, {
      conversationId: batchConversationId,
      contactId: batchContactId,
      watermarkMessageId: messages[40]?.messageId ?? "",
      now: due,
    });
    let modelCalls = 0;
    const client = new OpenAiCompatibleClient({
      baseUrl: "https://model.invalid",
      apiKey: "test",
      model: "deepseek-v4-flash",
      timeoutMs: 1_000,
      fetch: () => {
        modelCalls += 1;
        return Promise.resolve(
          Response.json({
            choices: [{ message: { content: '{"memories":[]}' } }],
          }),
        );
      },
    });
    await processMemoryCapture(postgres.db, client, "deepseek-v4-flash", {
      conversationId: batchConversationId,
      revision: 1,
    });
    const afterFirst = await postgres.db
      .select()
      .from(schema.memoryCaptureStates)
      .where(
        eq(schema.memoryCaptureStates.conversationId, batchConversationId),
      );
    expect(afterFirst[0]).toMatchObject({
      status: "scheduled",
      revision: 2,
      lastCapturedMessageId: messages[39]?.messageId,
    });
    await processMemoryCapture(postgres.db, client, "deepseek-v4-flash", {
      conversationId: batchConversationId,
      revision: 2,
    });
    const completed = await postgres.db
      .select()
      .from(schema.memoryCaptureStates)
      .where(
        eq(schema.memoryCaptureStates.conversationId, batchConversationId),
      );
    expect(completed[0]).toMatchObject({
      status: "completed",
      revision: 2,
      lastCapturedMessageId: messages[40]?.messageId,
    });
    expect(modelCalls).toBe(2);

    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(
        eq(schema.memoryCaptureStates.conversationId, batchConversationId),
      );
    await postgres.db
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, batchConversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, batchConversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, batchContactId));
  });
});

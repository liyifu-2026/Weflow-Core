import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import {
  MEMORY_CAPTURE_QUEUE,
  memoryCaptureJobId,
  startMemoryCaptureDispatcher,
} from "../infrastructure/redis/memory-capture-dispatcher.js";
import { createJobQueue } from "../infrastructure/redis/job-queue.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const integration = databaseUrl && redisUrl ? describe : describe.skip;

integration("Memory capture dispatcher recovery", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const contactId = `contact:memory-dispatch:${suffix}`;
  const conversationId = `channel:memory-dispatch-${suffix}`;
  const messageId = `memory-dispatch-message:${suffix}`;
  const revision = 1;
  const jobId = memoryCaptureJobId(conversationId, revision);

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "memory-dispatcher-test"),
    );
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `memory-dispatch-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `memory-dispatch-${suffix}`,
    });
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      actorId: contactId,
      contentType: "text",
      channelType: 1,
      text: "recover me",
      processingState: "received",
      idempotencyKey: messageId,
      occurredAt: new Date(),
      traceId: messageId,
    });
    await postgres.db.insert(schema.memoryCaptureStates).values({
      conversationId,
      contactId,
      watermarkMessageId: messageId,
      revision,
      status: "running",
      scheduledAt: new Date(Date.now() - 1_000),
    });
  });

  afterAll(async () => {
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

  it("recreates a lost Redis job from a running PostgreSQL fact", async () => {
    const queue = createJobQueue(MEMORY_CAPTURE_QUEUE, redisUrl ?? "");
    const oldJob = await queue.getJob(jobId);
    await oldJob?.remove();
    const stop = startMemoryCaptureDispatcher({
      db: postgres.db,
      redisUrl: redisUrl ?? "",
      logger: createLogger({ logLevel: "silent" }, "memory-dispatcher-test"),
      intervalMs: 20,
    });

    let job = await queue.getJob(jobId);
    for (let attempt = 0; !job && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = await queue.getJob(jobId);
    }
    expect(job?.data).toMatchObject({
      jobType: "memory.capture",
      businessEntityId: conversationId,
    });
    stop();
    await queue.close();
  });
});

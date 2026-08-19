import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import {
  currentChannelCursor,
  ingestChannelEvents,
} from "../modules/conversations/application/ingest-channel-events.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Channel Host inbound image ingestion", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationRef = `channel-image-${suffix}`;
  const conversationId = `channel:${conversationRef}`;
  const contactId = `contact:channel:${conversationRef}`;
  const eventId = `channel:${conversationRef}:image-1`;
  const messageId = `channel:${eventId}`;

  beforeAll(() => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "channel-image-integration-test"),
    );
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, conversationId));
    await postgres.db
      .delete(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
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
    await postgres.db
      .delete(schema.channelCursors)
      .where(eq(schema.channelCursors.source, "channel-host"));
    await postgres.close();
  });

  it("persists opaque channel media identity without parsing local_id", async () => {
    const mediaRef = `channel-media:v1:${suffix}`;
    const event = {
      eventId,
      cursor: "7",
      conversationRef,
      channelMessageId: "opaque-message-id",
      senderRef: "wxid-contact",
      kind: "image",
      content: "[image]",
      mediaRef,
      occurredAt: "2026-08-17T00:00:00Z",
      observedAt: "2026-08-17T00:00:01Z",
      isSelf: false,
    } as const;

    await ingestChannelEvents(postgres.db, [event], event.cursor);
    await ingestChannelEvents(postgres.db, [event], event.cursor);

    const messages = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, messageId));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channelMessageId: "opaque-message-id",
      contentType: "image",
      text: "[image]",
    });

    const assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      sourceLocalId: null,
      sourceMediaRef: mediaRef,
      kind: "image",
    });
    expect(["queued", "downloading"]).toContain(assets[0]?.status);
    await expect(currentChannelCursor(postgres.db)).resolves.toBe(7);
  });
});

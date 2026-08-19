import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStorage } from "../infrastructure/file_storage/local-file-storage.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import type { ChannelMediaSource } from "../modules/channel/contracts/channel-media-source.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import { syncChannelImages } from "../modules/media/application/sync-channel-images.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Channel Host image media synchronization", () => {
  let postgres: Postgres;
  let root: string;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationRef = `channel-media-${suffix}`;
  const conversationId = `channel:${conversationRef}`;
  const contactId = `contact:channel:${conversationRef}`;
  const eventId = `channel:${conversationRef}:image-1`;
  const messageId = `channel:${eventId}`;
  const mediaRef = `channel-media:v1:${suffix}`;
  const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "weflow-channel-media-"));
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "channel-media-processing-test"),
    );
  });

  afterAll(async () => {
    const assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, conversationId));
    const fileIds = assets
      .map((asset) => asset.originalFileId)
      .filter((fileId): fileId is string => Boolean(fileId));
    await postgres.db
      .delete(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, conversationId));
    for (const fileId of fileIds) {
      await postgres.db
        .delete(schema.storedFiles)
        .where(eq(schema.storedFiles.fileId, fileId));
    }
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
    await rm(root, { recursive: true, force: true });
  });

  it("copies a ready Channel image into the existing media state machine", async () => {
    await ingestChannelEvents(
      postgres.db,
      [
        {
          eventId,
          cursor: "8",
          conversationRef,
          channelMessageId: "opaque-message-id",
          senderRef: "wxid-contact",
          kind: "image",
          content: "[image]",
          mediaRef,
          occurredAt: "2026-08-17T00:00:00Z",
          observedAt: "2026-08-17T00:00:01Z",
          isSelf: false,
        },
      ],
      "8",
    );
    const source: ChannelMediaSource = {
      resolveImage: (ref) => {
        expect(ref).toBe(mediaRef);
        const body = new Response(imageBytes).body;
        if (!body) throw new Error("image response body is unavailable");
        return Promise.resolve({
          state: "ready",
          body,
          mimeType: "image/jpeg",
        });
      },
    };
    const storage = new LocalFileStorage(root);

    await syncChannelImages(postgres.db, storage, source);
    await syncChannelImages(postgres.db, storage, source);

    const assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      sourceLocalId: null,
      sourceMediaRef: mediaRef,
      status: "processing_queued",
    });
    const file = await postgres.db
      .select()
      .from(schema.storedFiles)
      .where(eq(schema.storedFiles.fileId, assets[0]?.originalFileId ?? ""));
    expect(file).toHaveLength(1);
    await expect(
      readFile(join(root, file[0]?.storageKey ?? "")),
    ).resolves.toEqual(Buffer.from(imageBytes));
  });
});

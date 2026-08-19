import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  STALE_RUNNING_TURN_MS,
  resetStaleRunningTurns,
} from "../infrastructure/redis/agent-turn-dispatcher.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationDatabaseUrl = databaseUrl ?? "";
const integration = databaseUrl ? describe : describe.skip;

integration("Agent turn stale-running recovery", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const channelConversationId = `stale-running-${suffix}`;
  const conversationId = `channel:${channelConversationId}`;
  const contactId = `contact:channel:${channelConversationId}`;

  beforeAll(() => {
    postgres = createPostgres(
      integrationDatabaseUrl,
      createLogger({ logLevel: "silent" }, "integration-test"),
    );
  });

  afterAll(async () => {
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

  it("resets only stale running turns back to queued", async () => {
    const events = [1, 2, 3, 4].map((index) => ({
      cursor: String(60 + index),
      eventId: `stale-running-${suffix}-${String(index)}`,
      conversationRef: channelConversationId,
      channelMessageId: `server-${suffix}-${String(index)}`,
      serverId: `19860763026721670${String(index)}`,
      localId: String(index),
      senderId: "wxid_stale_running",
      type: 1,
      kind: "text",
      content: `stale running message ${String(index)}`,
      occurredAt: new Date((1_700_000_000 + index) * 1000).toISOString(),
      observedAt: new Date((1_700_000_000 + index) * 1000).toISOString(),
      isSelf: false,
    }));
    await ingestChannelEvents(postgres.db, events, "64");

    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId))
      .orderBy(asc(schema.agentTurns.turnId));
    expect(turns).toHaveLength(4);

    const now = new Date();
    const staleStartedAt = new Date(
      now.getTime() - STALE_RUNNING_TURN_MS - 60_000,
    );
    const recentStartedAt = new Date(now.getTime() - 60_000);
    const states: Array<{ status: string; startedAt: Date | null }> = [
      { status: "running", startedAt: staleStartedAt },
      { status: "running", startedAt: recentStartedAt },
      { status: "queued", startedAt: staleStartedAt },
      { status: "completed", startedAt: staleStartedAt },
    ];
    for (const [index, turn] of turns.entries()) {
      const state = states[index];
      if (!state) throw new Error("missing expected state");
      await postgres.db
        .update(schema.agentTurns)
        .set({ status: state.status, startedAt: state.startedAt })
        .where(eq(schema.agentTurns.turnId, turn.turnId));
    }

    const staleBefore = new Date(now.getTime() - STALE_RUNNING_TURN_MS);
    const reset = await resetStaleRunningTurns(
      postgres.db,
      staleBefore,
      conversationId,
    );
    expect(reset).toHaveLength(1);
    expect(reset[0]).toBe(turns[0]?.turnId);

    const after = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId))
      .orderBy(asc(schema.agentTurns.turnId));
    expect(after[0]).toMatchObject({ status: "queued", startedAt: null });
    expect(after[1]).toMatchObject({ status: "running" });
    expect(after[2]).toMatchObject({ status: "queued" });
    expect(after[3]).toMatchObject({ status: "completed" });
    expect(after[0]?.errorCode).toBeNull();
  });

  it("leaves running turns without startedAt untouched", async () => {
    const events = [
      {
        cursor: "65",
        eventId: `stale-running-${suffix}-no-start`,
        conversationRef: channelConversationId,
        channelMessageId: `server-${suffix}-nostart`,
        serverId: "1986076302672167050",
        localId: "50",
        senderId: "wxid_stale_running",
        type: 1,
        kind: "text",
        content: "stale running message without startedAt",
        occurredAt: "2026-08-17T00:00:50.000Z",
        observedAt: "2026-08-17T00:00:51.000Z",
        isSelf: false,
      },
    ];
    await ingestChannelEvents(postgres.db, events, "65");
    const turn = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(
        and(
          eq(schema.agentTurns.conversationId, conversationId),
          eq(
            schema.agentTurns.triggerMessageId,
            `channel:stale-running-${suffix}-no-start`,
          ),
        ),
      );
    const staleTurn = turn[0];
    if (!staleTurn) throw new Error("expected a turn");
    await postgres.db
      .update(schema.agentTurns)
      .set({ status: "running", startedAt: null })
      .where(eq(schema.agentTurns.turnId, staleTurn.turnId));

    await resetStaleRunningTurns(
      postgres.db,
      new Date(Date.now() - STALE_RUNNING_TURN_MS),
    );
    const after = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, staleTurn.turnId));
    expect(after[0]).toMatchObject({ status: "running", startedAt: null });
  });
});

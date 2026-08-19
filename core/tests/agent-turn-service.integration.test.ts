import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { AgentTurnService } from "../modules/agent/application/agent-turn-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("AgentTurnService terminal lifecycle", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  let sequence = 0;

  beforeAll(() => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "agent-turn-service-test"),
    );
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.agentTurnEvents)
      .where(
        like(
          schema.agentTurnEvents.conversationId,
          `channel:agent-turn-service-${suffix}-%`,
        ),
      );
    await postgres.db
      .delete(schema.agentTurns)
      .where(
        like(
          schema.agentTurns.conversationId,
          `channel:agent-turn-service-${suffix}-%`,
        ),
      );
    await postgres.db
      .delete(schema.messages)
      .where(
        like(
          schema.messages.conversationId,
          `channel:agent-turn-service-${suffix}-%`,
        ),
      );
    await postgres.db
      .delete(schema.conversations)
      .where(
        like(
          schema.conversations.conversationId,
          `channel:agent-turn-service-${suffix}-%`,
        ),
      );
    await postgres.db
      .delete(schema.contactProfiles)
      .where(
        like(
          schema.contactProfiles.contactId,
          `contact:channel:agent-turn-service-${suffix}-%`,
        ),
      );
    await postgres.close();
  });

  it("does not allow a late failure to overwrite completed", async () => {
    const seed = await seedTurn("running");
    const service = new AgentTurnService(postgres.db);

    await expect(
      service.complete(seed.turnId, {
        responseText: "done",
        responseSegments: ["done"],
        errorCode: null,
      }),
    ).resolves.toMatchObject({ applied: true });
    await expect(service.fail(seed.turnId, "retry_exhausted")).resolves.toEqual(
      { applied: false, currentStatus: "completed" },
    );

    const rows = await postgres.db
      .select({ status: schema.agentTurns.status })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, seed.turnId));
    expect(rows[0]?.status).toBe("completed");
  });

  it("completes tool-planned work and protects terminal states", async () => {
    const planned = await seedTurn("tool_planned");
    const service = new AgentTurnService(postgres.db);

    await expect(service.complete(planned.turnId)).resolves.toMatchObject({
      applied: true,
    });
    await expect(
      service.supersede(planned.turnId, "newer_turn_exists"),
    ).resolves.toEqual({ applied: false, currentStatus: "completed" });
  });

  it.each([
    "completed",
    "failed",
    "superseded",
    "suppressed_policy",
    "suppressed_handoff",
  ])("does not let a terminal state be failed again: %s", async (status) => {
    const seed = await seedTurn(status);
    const service = new AgentTurnService(postgres.db);

    await expect(service.fail(seed.turnId, "retry_exhausted")).resolves.toEqual(
      { applied: false, currentStatus: status },
    );
  });

  it("allows legal failure and supersede transitions", async () => {
    const failed = await seedTurn("running");
    const superseded = await seedTurn("tool_planned");
    const service = new AgentTurnService(postgres.db);

    await expect(
      service.fail(failed.turnId, "provider_failed"),
    ).resolves.toEqual({ applied: true, status: "failed" });
    await expect(
      service.supersede(superseded.turnId, "case_revision_conflict"),
    ).resolves.toEqual({ applied: true, status: "superseded" });
  });

  it("preserves a specific handoff reason against a later generic suppression", async () => {
    const seed = await seedTurn("suppressed_handoff", "high_risk_topic");
    const service = new AgentTurnService(postgres.db);

    await expect(
      service.suppressHandoff(seed.turnId, "handoff_active"),
    ).resolves.toEqual({ applied: false, currentStatus: "suppressed_handoff" });

    const rows = await postgres.db
      .select({
        status: schema.agentTurns.status,
        errorCode: schema.agentTurns.errorCode,
      })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, seed.turnId));
    expect(rows[0]).toEqual({
      status: "suppressed_handoff",
      errorCode: "high_risk_topic",
    });
  });

  it("excludes the initiating turn from generic handoff suppression", async () => {
    const initiator = await seedTurn("running");
    const siblingMessageId = `${initiator.turnId}-sibling-message`;
    const siblingTurnId = `${initiator.turnId}-sibling`;
    await postgres.db.insert(schema.messages).values({
      messageId: siblingMessageId,
      conversationId: initiator.conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text: "sibling turn",
      processingState: "received",
      idempotencyKey: siblingMessageId,
      occurredAt: new Date(),
      traceId: siblingMessageId,
    });
    await postgres.db.insert(schema.agentTurns).values({
      turnId: siblingTurnId,
      triggerMessageId: siblingMessageId,
      conversationId: initiator.conversationId,
      status: "running",
      traceId: siblingTurnId,
    });

    const service = new AgentTurnService(postgres.db);
    await expect(
      service.suppressHandoffForConversation(
        initiator.conversationId,
        "handoff_active",
        initiator.turnId,
      ),
    ).resolves.toBe(1);
    await expect(
      service.suppressHandoff(initiator.turnId, "high_risk_topic"),
    ).resolves.toEqual({ applied: true, status: "suppressed_handoff" });

    const rows = await postgres.db
      .select({
        turnId: schema.agentTurns.turnId,
        status: schema.agentTurns.status,
        errorCode: schema.agentTurns.errorCode,
      })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, initiator.conversationId));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: initiator.turnId,
          status: "suppressed_handoff",
          errorCode: "high_risk_topic",
        }),
        expect.objectContaining({
          turnId: siblingTurnId,
          status: "suppressed_handoff",
          errorCode: "handoff_active",
        }),
      ]),
    );
  });

  it("allows only one concurrent terminal transition", async () => {
    const seed = await seedTurn("running");
    const service = new AgentTurnService(postgres.db);

    const [completed, failed] = await Promise.all([
      service.complete(seed.turnId),
      service.fail(seed.turnId, "retry_exhausted"),
    ]);

    expect([completed.applied, failed.applied].filter(Boolean)).toHaveLength(1);
    const rows = await postgres.db
      .select({ status: schema.agentTurns.status })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, seed.turnId));
    expect(["completed", "failed"]).toContain(rows[0]?.status);
  });

  it("allows only one worker to claim a queued turn", async () => {
    const seed = await seedTurn("queued");
    const service = new AgentTurnService(postgres.db);

    const [first, second] = await Promise.all([
      service.claim(seed.turnId, "test-model"),
      service.claim(seed.turnId, "test-model"),
    ]);

    expect([first.applied, second.applied].filter(Boolean)).toHaveLength(1);
    const rows = await postgres.db
      .select({
        status: schema.agentTurns.status,
        attempt: schema.agentTurns.attempt,
      })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, seed.turnId));
    expect(rows[0]).toMatchObject({ status: "running", attempt: 1 });
  });

  it("participates in the caller transaction and rolls back with it", async () => {
    const seed = await seedTurn("running");

    await expect(
      postgres.db.transaction(async (transaction) => {
        const result = await new AgentTurnService(transaction).complete(
          seed.turnId,
        );
        expect(result.applied).toBe(true);
        throw new Error("rollback agent turn test");
      }),
    ).rejects.toThrow("rollback agent turn test");

    const rows = await postgres.db
      .select({ status: schema.agentTurns.status })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, seed.turnId));
    expect(rows[0]?.status).toBe("running");
  });

  async function seedTurn(
    status: string,
    errorCode: string | null = null,
  ): Promise<{
    turnId: string;
    conversationId: string;
  }> {
    sequence += 1;
    const key = `${suffix}-${String(sequence)}`;
    const conversationId = `channel:agent-turn-service-${key}`;
    const contactId = `contact:channel:agent-turn-service-${key}`;
    const messageId = `agent-turn-service-message-${key}`;
    const turnId = `agent-turn-service-turn-${key}`;

    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `agent-turn-service-${key}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `agent-turn-service-${key}`,
    });
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text: "agent turn service test",
      processingState: "received",
      idempotencyKey: messageId,
      occurredAt: new Date(),
      traceId: messageId,
    });
    await postgres.db.insert(schema.agentTurns).values({
      turnId,
      triggerMessageId: messageId,
      conversationId,
      status,
      errorCode,
      traceId: turnId,
    });
    return { turnId, conversationId };
  }
});

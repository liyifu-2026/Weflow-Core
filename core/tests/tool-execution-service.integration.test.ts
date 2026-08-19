import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { executeToolPlan } from "../modules/agent/application/execute-tool-plan.js";
import {
  TOOL_EXECUTION_LEASE_MS,
  ToolExecutionService,
} from "../modules/agent/application/tool-execution-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("ToolExecutionService lifecycle", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  let sequence = 0;

  beforeAll(() => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "tool-execution-service-test"),
    );
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.toolExecutions)
      .where(
        like(
          schema.toolExecutions.conversationId,
          `channel:tool-service-${suffix}-%`,
        ),
      );
    await postgres.db
      .delete(schema.agentTurns)
      .where(
        like(
          schema.agentTurns.conversationId,
          `channel:tool-service-${suffix}-%`,
        ),
      );
    await postgres.db
      .delete(schema.messages)
      .where(
        like(
          schema.messages.conversationId,
          `channel:tool-service-${suffix}-%`,
        ),
      );
    await postgres.db
      .delete(schema.conversations)
      .where(
        like(
          schema.conversations.conversationId,
          `channel:tool-service-${suffix}-%`,
        ),
      );
    await postgres.db
      .delete(schema.contactProfiles)
      .where(
        like(
          schema.contactProfiles.contactId,
          `contact:channel:tool-service-${suffix}-%`,
        ),
      );
    await postgres.close();
  });

  it("allows only one worker to claim a planned execution", async () => {
    const seed = await seedExecution();
    const service = new ToolExecutionService(postgres.db);

    const [first, second] = await Promise.all([
      service.claim(seed.executionId),
      service.claim(seed.executionId),
    ]);

    expect([first.status, second.status].sort()).toEqual([
      "claimed",
      "not_claimable",
    ]);
    const rows = await postgres.db
      .select({ status: schema.toolExecutions.status })
      .from(schema.toolExecutions)
      .where(eq(schema.toolExecutions.executionId, seed.executionId));
    expect(rows[0]?.status).toBe("running");
  });

  it("persists success only from running", async () => {
    const seed = await seedExecution();
    const service = new ToolExecutionService(postgres.db);
    await service.claim(seed.executionId);

    const result = { profile: { note: "persisted" } };
    await expect(service.complete(seed.executionId, result)).resolves.toEqual({
      status: "succeeded",
      result,
    });
    const rows = await postgres.db
      .select()
      .from(schema.toolExecutions)
      .where(eq(schema.toolExecutions.executionId, seed.executionId));
    expect(rows[0]).toMatchObject({ status: "succeeded", result });
    expect(rows[0]?.completedAt).toBeInstanceOf(Date);
  });

  it("does not allow a late worker to complete a reclaimed lease", async () => {
    const seed = await seedExecution();
    const service = new ToolExecutionService(postgres.db);
    const first = await service.claim(seed.executionId);
    if (first.status !== "claimed") throw new Error("initial claim failed");

    await postgres.db
      .update(schema.toolExecutions)
      .set({
        claimedAt: new Date(Date.now() - TOOL_EXECUTION_LEASE_MS - 1_000),
        leaseUntil: new Date(Date.now() - 1_000),
      })
      .where(eq(schema.toolExecutions.executionId, seed.executionId));

    const second = await service.claim(seed.executionId);
    if (second.status !== "claimed") throw new Error("reclaim failed");
    await expect(
      service.complete(
        seed.executionId,
        { owner: "stale" },
        first.execution.claimedAt,
      ),
    ).resolves.toEqual({
      status: "not_claimable",
      errorCode: "tool_lease_lost",
    });
    await expect(
      service.complete(
        seed.executionId,
        { owner: "current" },
        second.execution.claimedAt,
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("reclaims a legacy running execution with no lease after the turn is stale", async () => {
    const seed = await seedExecution();
    await postgres.db
      .update(schema.agentTurns)
      .set({
        startedAt: new Date(Date.now() - TOOL_EXECUTION_LEASE_MS - 1_000),
      })
      .where(eq(schema.agentTurns.turnId, seed.turnId));
    await postgres.db
      .update(schema.toolExecutions)
      .set({ status: "running", claimedAt: null, leaseUntil: null })
      .where(eq(schema.toolExecutions.executionId, seed.executionId));

    const result = await new ToolExecutionService(postgres.db).claim(
      seed.executionId,
    );
    expect(result.status).toBe("claimed");
  });

  it("persists failure only from running", async () => {
    const seed = await seedExecution();
    const service = new ToolExecutionService(postgres.db);
    await service.claim(seed.executionId);

    await expect(
      service.fail(seed.executionId, "provider_failed"),
    ).resolves.toEqual({
      status: "failed",
      errorCode: "provider_failed",
    });
    const rows = await postgres.db
      .select()
      .from(schema.toolExecutions)
      .where(eq(schema.toolExecutions.executionId, seed.executionId));
    expect(rows[0]).toMatchObject({
      status: "failed",
      errorCode: "provider_failed",
    });
    expect(rows[0]?.completedAt).toBeInstanceOf(Date);
  });

  it("does not let a late failure overwrite succeeded", async () => {
    const seed = await seedExecution();
    const service = new ToolExecutionService(postgres.db);
    await service.claim(seed.executionId);
    const result = { evidence: [{ source: "snapshot" }] };
    await service.complete(seed.executionId, result);

    await expect(
      service.fail(seed.executionId, "late_failure"),
    ).resolves.toEqual({
      status: "already_completed",
      result,
    });
    const rows = await postgres.db
      .select({ status: schema.toolExecutions.status })
      .from(schema.toolExecutions)
      .where(eq(schema.toolExecutions.executionId, seed.executionId));
    expect(rows[0]?.status).toBe("succeeded");
  });

  it("does not let a late success overwrite failed", async () => {
    const seed = await seedExecution();
    const service = new ToolExecutionService(postgres.db);
    await service.claim(seed.executionId);
    await service.fail(seed.executionId, "provider_failed");

    await expect(
      service.complete(seed.executionId, { should: "not persist" }),
    ).resolves.toEqual({ status: "failed", errorCode: "provider_failed" });
    const rows = await postgres.db
      .select({ status: schema.toolExecutions.status })
      .from(schema.toolExecutions)
      .where(eq(schema.toolExecutions.executionId, seed.executionId));
    expect(rows[0]?.status).toBe("failed");
  });

  it("reuses a persisted success without invoking the executor again", async () => {
    const seed = await seedExecution();
    let calls = 0;
    const executor = () => {
      calls += 1;
      return Promise.resolve({
        evidence: [{ source: "stable" }],
        retrievedAt: "now",
      });
    };

    const first = await executeToolPlan(postgres.db, seed.executionId, {
      executor,
    });
    const second = await executeToolPlan(postgres.db, seed.executionId, {
      executor,
    });

    expect(first).toEqual({
      status: "succeeded",
      result: { evidence: [{ source: "stable" }], retrievedAt: "now" },
    });
    expect(second).toEqual({
      status: "already_completed",
      result: { evidence: [{ source: "stable" }], retrievedAt: "now" },
    });
    expect(calls).toBe(1);
  });

  it("keeps a knowledge evidence snapshot unchanged on retry", async () => {
    const seed = await seedExecution("retrieve_knowledge", { query: "E203" });
    const evidence = {
      query: "E203",
      evidence: [{ source: "guide.pdf", snippet: "restart" }],
      retrievedAt: "2026-08-16T00:00:00.000Z",
    };
    let calls = 0;
    const result = await executeToolPlan(postgres.db, seed.executionId, {
      executor: () => {
        calls += 1;
        return Promise.resolve(evidence);
      },
    });
    const retry = await executeToolPlan(postgres.db, seed.executionId, {
      executor: () => {
        calls += 1;
        return Promise.resolve({ changed: true });
      },
    });

    expect(result).toEqual({ status: "succeeded", result: evidence });
    expect(retry).toEqual({ status: "already_completed", result: evidence });
    expect(calls).toBe(1);
  });

  it("runs the provider after the claim transaction is committed", async () => {
    const seed = await seedExecution();
    let providerStarted!: () => void;
    let releaseProvider!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const execution = executeToolPlan(postgres.db, seed.executionId, {
      executor: async () => {
        providerStarted();
        await release;
        return { profile: null };
      },
    });

    await started;
    const rows = await postgres.db
      .select({ status: schema.toolExecutions.status })
      .from(schema.toolExecutions)
      .where(eq(schema.toolExecutions.executionId, seed.executionId));
    expect(rows[0]?.status).toBe("running");
    releaseProvider();
    await execution;
  });

  it("maps provider failure to failed without touching AgentTurn", async () => {
    const seed = await seedExecution();
    const result = await executeToolPlan(postgres.db, seed.executionId, {
      executor: () => Promise.reject(new Error("provider_failed")),
    });

    expect(result).toEqual({ status: "failed", errorCode: "provider_failed" });
    const turns = await postgres.db
      .select({ status: schema.agentTurns.status })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, seed.turnId));
    const handoffs = await postgres.db
      .select()
      .from(schema.handoffStates)
      .where(eq(schema.handoffStates.conversationId, seed.conversationId));
    expect(turns[0]?.status).toBe("tool_planned");
    expect(handoffs).toHaveLength(0);
  });

  it("returns not_claimable for running and failed executions", async () => {
    const running = await seedExecution();
    const failed = await seedExecution();
    const service = new ToolExecutionService(postgres.db);
    await service.claim(running.executionId);
    await service.claim(failed.executionId);
    await service.fail(failed.executionId, "provider_failed");

    await expect(service.claim(running.executionId)).resolves.toMatchObject({
      status: "not_claimable",
      currentStatus: "running",
    });
    await expect(service.claim(failed.executionId)).resolves.toMatchObject({
      status: "not_claimable",
      currentStatus: "failed",
    });
  });

  it("does not create a second execution for a duplicate idempotency key", async () => {
    const seed = await seedExecution();
    const duplicateId = `${seed.executionId}:duplicate`;
    await postgres.db
      .insert(schema.toolExecutions)
      .values({
        executionId: duplicateId,
        turnId: seed.turnId,
        conversationId: seed.conversationId,
        toolName: "query_contact_profile",
        status: "planned",
        idempotencyKey: seed.executionId,
        arguments: {},
      })
      .onConflictDoNothing();
    const rows = await postgres.db
      .select({ executionId: schema.toolExecutions.executionId })
      .from(schema.toolExecutions)
      .where(eq(schema.toolExecutions.idempotencyKey, seed.executionId));
    expect(rows).toEqual([{ executionId: seed.executionId }]);
  });

  async function seedExecution(
    toolName:
      "query_contact_profile" | "retrieve_knowledge" = "query_contact_profile",
    argumentsValue: Record<string, string> = {},
  ): Promise<{
    executionId: string;
    turnId: string;
    conversationId: string;
  }> {
    sequence += 1;
    const key = `${suffix}-${String(sequence)}`;
    const conversationId = `channel:tool-service-${key}`;
    const contactId = `contact:channel:tool-service-${key}`;
    const messageId = `tool-service-message-${key}`;
    const turnId = `tool-service-turn-${key}`;
    const executionId = `agent-tool:${turnId}`;

    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `tool-service-${key}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `tool-service-${key}`,
    });
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text: "tool execution test",
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
      toolName,
      status: "planned",
      idempotencyKey: executionId,
      arguments: argumentsValue,
    });
    return { executionId, turnId, conversationId };
  }
});

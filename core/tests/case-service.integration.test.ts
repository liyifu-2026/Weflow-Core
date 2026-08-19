import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { applyCaseStateUpdate } from "../modules/conversations/application/case-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("case service", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationId = `channel:case-service-${suffix}`;
  const contactId = `contact:channel:case-service-${suffix}`;

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "case-service-test"),
    );
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `case-service-${suffix}`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `case-service-${suffix}`,
    });
    await postgres.db.insert(schema.caseStates).values({ conversationId });
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.caseStates)
      .where(eq(schema.caseStates.conversationId, conversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, contactId));
    await postgres.close();
  });

  it("persists an agent case update and advances the revision", async () => {
    const result = await applyCaseStateUpdate(postgres.db, {
      conversationId,
      expectedRevision: 0,
      patch: {
        intent: "device_troubleshooting",
        stage: "collecting_information",
        knownFields: { device_model: "X1" },
        missingFields: ["serial_number"],
        askedFields: [],
        actionHistory: [],
        requiresHuman: false,
        riskLevel: "low",
      },
    });

    expect(result.status).toBe("updated");
    const [state] = await postgres.db
      .select()
      .from(schema.caseStates)
      .where(eq(schema.caseStates.conversationId, conversationId));
    expect(state).toMatchObject({
      revision: 1,
      intent: "device_troubleshooting",
      stage: "collecting_information",
      knownFields: { device_model: "X1" },
      missingFields: ["serial_number"],
    });
  });

  it("reports a revision conflict without changing the case", async () => {
    const result = await applyCaseStateUpdate(postgres.db, {
      conversationId,
      expectedRevision: 0,
      patch: { stage: "resolved" },
    });

    expect(result).toEqual({ status: "revision_conflict" });
    const [state] = await postgres.db
      .select()
      .from(schema.caseStates)
      .where(eq(schema.caseStates.conversationId, conversationId));
    expect(state).toMatchObject({
      revision: 1,
      stage: "collecting_information",
    });
  });

  it("rolls back a CaseState update with the caller transaction", async () => {
    await expect(
      postgres.db.transaction(async (transaction) => {
        const result = await applyCaseStateUpdate(transaction, {
          conversationId,
          expectedRevision: 1,
          patch: { stage: "resolved" },
        });
        expect(result.status).toBe("updated");
        throw new Error("rollback_case_update");
      }),
    ).rejects.toThrow("rollback_case_update");

    const [state] = await postgres.db
      .select()
      .from(schema.caseStates)
      .where(eq(schema.caseStates.conversationId, conversationId));
    expect(state).toMatchObject({
      revision: 1,
      stage: "collecting_information",
    });
  });
});

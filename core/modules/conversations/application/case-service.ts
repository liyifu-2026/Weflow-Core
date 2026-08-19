/**
 * CaseState persistence boundary for Agent-owned case updates.
 *
 * The caller remains responsible for producing the candidate facts,
 * questions, actions, and decision fields. This service owns only the
 * authoritative revision-checked write and deliberately uses the caller's
 * database context so it participates in an existing transaction.
 */
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

type DatabaseTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

type CaseDatabase = NodePgDatabase<typeof schema> | DatabaseTransaction;

type PersistedCaseFields =
  | "intent"
  | "stage"
  | "knownFields"
  | "missingFields"
  | "askedFields"
  | "actionHistory"
  | "requiresHuman"
  | "riskLevel";

export type CaseStatePatch = Partial<
  Pick<typeof schema.caseStates.$inferInsert, PersistedCaseFields>
>;

export type ApplyCaseStateUpdateInput = {
  conversationId: string;
  expectedRevision: number;
  patch: CaseStatePatch;
};

export type ApplyCaseStateUpdateResult =
  { status: "updated"; revision: number } | { status: "revision_conflict" };

/**
 * Applies one revision-checked CaseState update.
 *
 * No transaction is opened here. When called with a transaction context, the
 * CaseState update commits or rolls back together with the caller's other
 * Agent, Message, and Tool records.
 */
export async function applyCaseStateUpdate(
  db: CaseDatabase,
  input: ApplyCaseStateUpdateInput,
): Promise<ApplyCaseStateUpdateResult> {
  const updated = await db
    .update(schema.caseStates)
    .set({
      ...input.patch,
      revision: sql`${schema.caseStates.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.caseStates.conversationId, input.conversationId),
        eq(schema.caseStates.revision, input.expectedRevision),
      ),
    )
    .returning({ revision: schema.caseStates.revision });

  const state = updated[0];
  return state
    ? { status: "updated", revision: state.revision }
    : { status: "revision_conflict" };
}

/**
 * Agent Execution Profile admission service.
 *
 * A new Agent Turn may only be created when there is an active and compatible
 * Execution Profile. This module is the single admission authority used by
 * turn creation paths.
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

export type AgentExecutionProfileRow =
  typeof schema.agentExecutionProfiles.$inferSelect;

export type ExecutionProfileAdmission =
  | { allowed: true; profile: AgentExecutionProfileRow }
  | { allowed: false; reasonCode: "agent_execution_profile_unavailable" };

export async function findActiveExecutionProfile(
  db: NodePgDatabase<typeof schema>,
): Promise<AgentExecutionProfileRow | undefined> {
  const rows = await db
    .select()
    .from(schema.agentExecutionProfiles)
    .where(eq(schema.agentExecutionProfiles.status, "active"))
    .limit(1);
  return rows[0];
}

export async function findExecutionProfileById(
  db: NodePgDatabase<typeof schema>,
  profileId: string,
): Promise<AgentExecutionProfileRow | undefined> {
  const rows = await db
    .select()
    .from(schema.agentExecutionProfiles)
    .where(eq(schema.agentExecutionProfiles.profileId, profileId))
    .limit(1);
  return rows[0];
}

export async function resolveExecutionProfileForAdmission(
  db: NodePgDatabase<typeof schema>,
): Promise<ExecutionProfileAdmission> {
  const profile = await findActiveExecutionProfile(db);
  return profile
    ? { allowed: true, profile }
    : { allowed: false, reasonCode: "agent_execution_profile_unavailable" };
}

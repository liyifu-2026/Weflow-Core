/** Queue failure reconciliation for an Agent Turn. */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { commitAgentTurnFailure } from "./agent-turn-outcome-command.js";

export async function reconcileAgentTurnQueueFailure(
  db: NodePgDatabase<typeof schema>,
  turnId: string,
  errorCode: string,
): Promise<void> {
  const rows = await db
    .select({ conversationId: schema.agentTurns.conversationId })
    .from(schema.agentTurns)
    .where(eq(schema.agentTurns.turnId, turnId))
    .limit(1);
  const conversationId = rows[0]?.conversationId;
  if (!conversationId) return;
  await commitAgentTurnFailure(db, {
    conversationId,
    turnId,
    errorCode,
    handoffReason: `model_unavailable: ${errorCode}`,
  });
}

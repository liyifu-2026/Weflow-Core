import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { AgentTurnDatabase } from "./agent-turn-service.js";

export type AgentTurnEventType =
  | "ownership_checked"
  | "execution_resumed"
  | "tool_execution_reclaimed"
  | "tool_checkpoint_persisted"
  | "context_built"
  | "triaged"
  | "policy_decided"
  | "knowledge_retrieved"
  | "tool_completed"
  | "draft_generated"
  | "validation_passed"
  | "validation_failed"
  | "handoff_created"
  | "reply_persisted"
  | "delivery_confirmed"
  | "delivery_unknown"
  | "delivery_failed";

export async function recordAgentTurnEvent(
  db: NodePgDatabase<typeof schema> | AgentTurnDatabase,
  input: {
    turnId: string;
    conversationId: string;
    eventType: AgentTurnEventType;
    reasonCode?: string | undefined;
    payload?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  await db.insert(schema.agentTurnEvents).values({
    eventId: `turn-event:${randomUUID()}`,
    turnId: input.turnId,
    conversationId: input.conversationId,
    eventType: input.eventType,
    reasonCode: input.reasonCode,
    payload: input.payload ?? {},
  });
}

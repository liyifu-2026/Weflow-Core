import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

type DatabaseTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

export type AgentTurnDatabase =
  NodePgDatabase<typeof schema> | DatabaseTransaction;

type AgentTurnUpdate = Partial<typeof schema.agentTurns.$inferInsert>;

type TransitionResult =
  | { applied: true; status: string }
  | { applied: false; currentStatus?: string };

export type CompleteAgentTurnInput = {
  responseText?: string | null;
  responseSegments?: string[] | null;
  model?: string | null;
  replyPolicyVersionId?: string | null;
  errorCode?: string | null;
  completedAt?: Date;
};

export type AgentTurnClaimResult =
  | { applied: true; turnId: string }
  | { applied: false; currentStatus?: string };

export class AgentTurnTransitionNotApplied extends Error {
  public constructor(turnId: string, targetStatus: string) {
    super(`Agent turn ${turnId} could not transition to ${targetStatus}`);
    this.name = "AgentTurnTransitionNotApplied";
  }
}

const EXECUTABLE_STATUSES = ["queued", "running", "tool_planned"] as const;

/** Owns the CAS boundary for terminal and pre-terminal AgentTurn transitions. */
export class AgentTurnService {
  public constructor(private readonly db: AgentTurnDatabase) {}

  /** Atomically claims a fresh or persisted-resume turn. */
  public async claim(
    turnId: string,
    model: string,
    sourceStatuses: readonly ("queued" | "tool_planned")[] = ["queued"],
  ): Promise<AgentTurnClaimResult> {
    const claimed = await this.db
      .update(schema.agentTurns)
      .set({
        status: "running",
        model,
        attempt: sql`${schema.agentTurns.attempt} + 1`,
        startedAt: new Date(),
        errorCode: null,
      })
      .where(
        and(
          eq(schema.agentTurns.turnId, turnId),
          inArray(schema.agentTurns.status, sourceStatuses as string[]),
        ),
      )
      .returning({ turnId: schema.agentTurns.turnId });
    if (claimed[0]) return { applied: true, turnId: claimed[0].turnId };
    const current = await this.db
      .select({ status: schema.agentTurns.status })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId))
      .limit(1);
    return current[0]
      ? { applied: false, currentStatus: current[0].status }
      : { applied: false };
  }

  /** Completes work that is still owned by an executing Agent worker. */
  public async complete(
    turnId: string,
    input: CompleteAgentTurnInput = {},
  ): Promise<TransitionResult> {
    const fields: AgentTurnUpdate = {
      completedAt: input.completedAt ?? new Date(),
    };
    if ("responseText" in input) fields.responseText = input.responseText;
    if ("responseSegments" in input) {
      fields.responseSegments = input.responseSegments;
    }
    if ("model" in input) fields.model = input.model;
    if ("replyPolicyVersionId" in input) {
      fields.replyPolicyVersionId = input.replyPolicyVersionId;
    }
    if ("errorCode" in input) fields.errorCode = input.errorCode;

    return this.transition(
      turnId,
      "completed",
      ["running", "tool_planned"],
      fields,
    );
  }

  /** Records a failed execution without overwriting a newer AgentTurn state. */
  public async fail(
    turnId: string,
    errorCode: string,
  ): Promise<TransitionResult> {
    return this.transition(turnId, "failed", EXECUTABLE_STATUSES, {
      errorCode,
    });
  }

  /** Marks an executable turn obsolete after a newer result wins. */
  public async supersede(
    turnId: string,
    errorCode: string,
  ): Promise<TransitionResult> {
    return this.transition(turnId, "superseded", EXECUTABLE_STATUSES, {
      errorCode,
    });
  }

  /** Suppresses an executable turn because policy disallows agent work. */
  public async suppressPolicy(
    turnId: string,
    errorCode: string,
  ): Promise<TransitionResult> {
    return this.transition(turnId, "suppressed_policy", EXECUTABLE_STATUSES, {
      errorCode,
    });
  }

  /** Suppresses an executable turn because human ownership is active. */
  public async suppressHandoff(
    turnId: string,
    errorCode: string,
  ): Promise<TransitionResult> {
    return this.transition(turnId, "suppressed_handoff", EXECUTABLE_STATUSES, {
      errorCode,
    });
  }

  /** Suppresses queued/running turns when an Agent is disabled for a conversation. */
  public async suppressPolicyForConversation(
    conversationId: string,
    errorCode: string,
  ): Promise<number> {
    return this.transitionMany(
      conversationId,
      "suppressed_policy",
      ["queued", "running"],
      { errorCode },
    );
  }

  /** Suppresses all executable turns when human ownership begins. */
  public async suppressHandoffForConversation(
    conversationId: string,
    errorCode: string,
    excludeTurnId?: string,
  ): Promise<number> {
    return this.transitionMany(
      conversationId,
      "suppressed_handoff",
      EXECUTABLE_STATUSES,
      { errorCode },
      excludeTurnId,
    );
  }

  private async transition(
    turnId: string,
    targetStatus: string,
    sourceStatuses: readonly string[],
    fields: AgentTurnUpdate,
  ): Promise<TransitionResult> {
    const updated = await this.db
      .update(schema.agentTurns)
      .set({ ...fields, status: targetStatus })
      .where(
        and(
          eq(schema.agentTurns.turnId, turnId),
          inArray(schema.agentTurns.status, sourceStatuses as string[]),
        ),
      )
      .returning({ turnId: schema.agentTurns.turnId });
    if (updated.length > 0) return { applied: true, status: targetStatus };

    const current = await this.db
      .select({ status: schema.agentTurns.status })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId))
      .limit(1);
    return current[0]
      ? { applied: false, currentStatus: current[0].status }
      : { applied: false };
  }

  private async transitionMany(
    conversationId: string,
    targetStatus: string,
    sourceStatuses: readonly string[],
    fields: AgentTurnUpdate,
    excludeTurnId?: string,
  ): Promise<number> {
    const conversationScope = excludeTurnId
      ? and(
          eq(schema.agentTurns.conversationId, conversationId),
          ne(schema.agentTurns.turnId, excludeTurnId),
        )
      : eq(schema.agentTurns.conversationId, conversationId);
    const updated = await this.db
      .update(schema.agentTurns)
      .set({ ...fields, status: targetStatus })
      .where(
        and(
          conversationScope,
          inArray(schema.agentTurns.status, sourceStatuses as string[]),
        ),
      )
      .returning({ turnId: schema.agentTurns.turnId });
    return updated.length;
  }
}

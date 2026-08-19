/**
 * Durable Agent Turn execution seam.
 *
 * The worker owns queue/process lifecycle only. This module owns the decision
 * of whether a turn starts from a fresh model decision or resumes a persisted
 * tool checkpoint. The older process modules remain compatibility adapters for
 * existing application tests while their implementation is being collapsed
 * behind this entry point.
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { TextModel } from "../../model/contracts/text-model.js";
import type { KnowledgeSearch } from "../../knowledge/contracts/knowledge-search.js";
import type { SkillRegistry } from "../contracts/agent-skill.js";
import type { ExecutionStrategyRegistry } from "../contracts/execution-strategy.js";
import { processAgentTurn } from "./process-agent-turn.js";
import { processPlannedToolTurn } from "./process-planned-tool-turn.js";
import { recordAgentTurnEvent } from "./agent-turn-events.js";
import { AgentTurnService } from "./agent-turn-service.js";

type Database = NodePgDatabase<typeof schema>;

export type AgentTurnExecutionInput = {
  turnId: string;
  traceId: string;
};

export type AgentTurnExecutionStatus =
  | "completed"
  | "failed"
  | "superseded"
  | "suppressed_policy"
  | "suppressed_handoff"
  | "queued"
  | "tool_planned"
  | "running"
  | "unknown";

export type AgentTurnExecutionResult = {
  turnId: string;
  conversationId: string;
  status: AgentTurnExecutionStatus;
  resumed: boolean;
};

export class AgentTurnExecutor {
  public constructor(
    private readonly db: Database,
    private readonly modelClient: TextModel,
    private readonly model: string,
    private readonly dependencies: {
      knowledgeSearch?: KnowledgeSearch | undefined;
      skillRegistry?: SkillRegistry | undefined;
      strategyRegistry?: ExecutionStrategyRegistry | undefined;
    } = {},
  ) {}

  /** Execute a fresh or persisted Agent Turn. */
  public async execute(
    input: AgentTurnExecutionInput,
  ): Promise<AgentTurnExecutionResult> {
    const before = await this.loadTurn(input.turnId);
    if (!before) throw new Error(`agent turn ${input.turnId} does not exist`);

    if (isTerminal(before.status)) {
      return {
        turnId: before.turnId,
        conversationId: before.conversationId,
        status: normalizeStatus(before.status),
        resumed: false,
      };
    }

    const persistedExecution = await this.loadToolExecution(input.turnId);
    const resumed =
      before.status === "tool_planned" ||
      (before.status === "queued" && persistedExecution !== undefined);
    const turnService = new AgentTurnService(this.db);
    if (
      before.status === "queued" &&
      persistedExecution?.status === "running" &&
      (!persistedExecution.leaseUntil ||
        persistedExecution.leaseUntil.getTime() > Date.now())
    ) {
      return this.resultAfterExecution(before, resumed);
    }
    if (before.status === "tool_planned") {
      const claimed = await turnService.claim(input.turnId, this.model, [
        "tool_planned",
      ]);
      if (!claimed.applied) {
        const current = await this.loadTurn(input.turnId);
        return {
          turnId: input.turnId,
          conversationId: current?.conversationId ?? before.conversationId,
          status: normalizeStatus(current?.status ?? before.status),
          resumed,
        };
      }
      await recordAgentTurnEvent(this.db, {
        turnId: before.turnId,
        conversationId: before.conversationId,
        eventType: "execution_resumed",
        payload: { sourceStatus: before.status },
      });
      await processPlannedToolTurn(
        this.db,
        this.modelClient,
        this.model,
        input.turnId,
        input.traceId,
        this.dependencies.knowledgeSearch,
        this.dependencies.skillRegistry,
        this.dependencies.strategyRegistry,
      );
    } else if (before.status === "queued") {
      const claimed = await turnService.claim(input.turnId, this.model, [
        "queued",
      ]);
      if (!claimed.applied) {
        return this.resultAfterExecution(before, resumed);
      }
      await recordAgentTurnEvent(this.db, {
        turnId: before.turnId,
        conversationId: before.conversationId,
        eventType: "ownership_checked",
        payload: { allowed: true, sourceStatus: before.status },
      });

      if (resumed) {
        await recordAgentTurnEvent(this.db, {
          turnId: before.turnId,
          conversationId: before.conversationId,
          eventType: "execution_resumed",
          payload: { sourceStatus: before.status },
        });
        await processPlannedToolTurn(
          this.db,
          this.modelClient,
          this.model,
          input.turnId,
          input.traceId,
          this.dependencies.knowledgeSearch,
          this.dependencies.skillRegistry,
          this.dependencies.strategyRegistry,
        );
      } else {
        await processAgentTurn(this.db, this.modelClient, this.model, input, {
          ...this.dependencies,
          claimed: true,
        });

        const afterDecision = await this.loadTurn(input.turnId);
        if (afterDecision?.status === "tool_planned") {
          const toolStageClaim = await turnService.claim(
            input.turnId,
            this.model,
            ["tool_planned"],
          );
          if (toolStageClaim.applied) {
            await recordAgentTurnEvent(this.db, {
              turnId: before.turnId,
              conversationId: before.conversationId,
              eventType: "execution_resumed",
              payload: { sourceStatus: "tool_planned" },
            });
            await processPlannedToolTurn(
              this.db,
              this.modelClient,
              this.model,
              input.turnId,
              input.traceId,
              this.dependencies.knowledgeSearch,
              this.dependencies.skillRegistry,
              this.dependencies.strategyRegistry,
            );
          }
        }
      }
    }

    return this.resultAfterExecution(before, resumed);
  }

  public async conversationIdFor(turnId: string): Promise<string> {
    const turn = await this.loadTurn(turnId);
    if (!turn) throw new Error(`agent turn ${turnId} does not exist`);
    return turn.conversationId;
  }

  private async loadTurn(turnId: string) {
    const rows = await this.db
      .select({
        turnId: schema.agentTurns.turnId,
        conversationId: schema.agentTurns.conversationId,
        status: schema.agentTurns.status,
      })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.turnId, turnId))
      .limit(1);
    return rows[0];
  }

  private async loadToolExecution(turnId: string) {
    const rows = await this.db
      .select({
        executionId: schema.toolExecutions.executionId,
        status: schema.toolExecutions.status,
        leaseUntil: schema.toolExecutions.leaseUntil,
      })
      .from(schema.toolExecutions)
      .where(eq(schema.toolExecutions.turnId, turnId))
      .limit(1);
    return rows[0];
  }

  private async resultAfterExecution(
    before: { turnId: string; conversationId: string; status: string },
    resumed: boolean,
  ): Promise<AgentTurnExecutionResult> {
    const after = await this.loadTurn(before.turnId);
    return {
      turnId: before.turnId,
      conversationId: after?.conversationId ?? before.conversationId,
      status: normalizeStatus(after?.status ?? before.status),
      resumed,
    };
  }
}

export async function getAgentTurnConversationId(
  db: Database,
  turnId: string,
): Promise<string> {
  const rows = await db
    .select({ conversationId: schema.agentTurns.conversationId })
    .from(schema.agentTurns)
    .where(eq(schema.agentTurns.turnId, turnId))
    .limit(1);
  if (!rows[0]) throw new Error(`agent turn ${turnId} does not exist`);
  return rows[0].conversationId;
}

function isTerminal(status: string): boolean {
  return [
    "completed",
    "failed",
    "superseded",
    "suppressed_policy",
    "suppressed_handoff",
  ].includes(status);
}

function normalizeStatus(status: string): AgentTurnExecutionStatus {
  if (
    status === "completed" ||
    status === "failed" ||
    status === "superseded" ||
    status === "suppressed_policy" ||
    status === "suppressed_handoff" ||
    status === "queued" ||
    status === "tool_planned" ||
    status === "running"
  ) {
    return status;
  }
  return "unknown";
}

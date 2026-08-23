/**
 * Agent Execution Strategy seam.
 *
 * The contract shapes (AgentAction, AgentExecutionStrategy,
 * ExecutionStrategyRegistry, …) are the authoritative ones from
 * `@weflow/contracts` (`src/agent.ts`); they are re-exported here so existing
 * Core import sites stay stable. Only the in-process registry implementation
 * lives in Core.
 */
export type {
  AgentActionMeta,
  AgentAction,
  HandoffBriefing,
  ModelMessage,
  ModelRequest,
  AgentStrategyContext,
  AgentStrategyResponse,
  AgentActionValidationInput,
  AgentActionValidation,
  AgentExecutionStrategy,
  ExecutionStrategyRegistry,
} from "@weflow/contracts";
export { isAgentAction } from "@weflow/contracts";

import type {
  AgentExecutionStrategy,
  ExecutionStrategyRegistry,
} from "@weflow/contracts";

export class MapExecutionStrategyRegistry implements ExecutionStrategyRegistry {
  private readonly strategies = new Map<string, AgentExecutionStrategy>();

  public constructor(strategies: readonly AgentExecutionStrategy[] = []) {
    for (const strategy of strategies) {
      this.strategies.set(strategy.id, strategy);
    }
  }

  public get(strategyId: string): AgentExecutionStrategy | undefined {
    return this.strategies.get(strategyId);
  }

  public has(strategyId: string): boolean {
    return this.strategies.has(strategyId);
  }

  public list(): AgentExecutionStrategy[] {
    return [...this.strategies.values()];
  }

  public register(strategy: AgentExecutionStrategy): void {
    this.strategies.set(strategy.id, strategy);
  }
}

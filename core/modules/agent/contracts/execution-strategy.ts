/**
 * Agent Execution Strategy contract.
 *
 * A Strategy owns how a model request is built, how a model response is parsed,
 * and how the resulting AgentAction is validated. It must not call the model,
 * database, Channel, or execute tools itself.
 */

/**
 * Optional strategy-owned metadata attached to an action.
 *
 * Core treats this payload as opaque: strategies may attach their own rich
 * decision context here without extending the base AgentAction contract.
 */
export type AgentActionMeta = Record<string, unknown>;

export type AgentAction =
  | {
      kind: "reply";
      segments: string[];
      statePatch?: Record<string, unknown>;
      meta?: AgentActionMeta;
    }
  | {
      kind: "ask";
      segments: string[];
      requestedFacts: string[];
      statePatch?: Record<string, unknown>;
      meta?: AgentActionMeta;
    }
  | {
      kind: "use_tool";
      tool: string;
      arguments: Record<string, string>;
      meta?: AgentActionMeta;
    }
  | {
      kind: "handoff";
      reasonCode: string;
      briefing: {
        reasonCode: string;
        problemSummary: string;
        unresolvedItems: string[];
        suggestedFirstReply: string;
      };
      meta?: AgentActionMeta;
    }
  | {
      kind: "no_action";
      reasonCode: string;
      meta?: AgentActionMeta;
    };

export interface AgentStrategyContext {
  conversationId: string;
  contactId: string;
  messages: { role: string; content: string }[];
  facts: Record<string, unknown>;
  availableTools: string[];
}

export interface ModelRequest {
  system: string;
  messages: { role: string; content: string }[];
  tools?: unknown[];
  maxTokens?: number;
}

export interface AgentStrategyResponse {
  text: string;
  raw?: unknown;
}

export interface AgentActionValidation {
  ok: boolean;
  reason?: string;
}

export interface AgentExecutionStrategy {
  id: string;
  version: string;
  buildModelRequest(input: AgentStrategyContext): ModelRequest;
  parseModelResponse(input: AgentStrategyResponse): AgentAction;
  validateAction(input: {
    action: AgentAction;
    context: AgentStrategyContext;
  }): AgentActionValidation;
}

export interface ExecutionStrategyRegistry {
  get(strategyId: string): AgentExecutionStrategy | undefined;
  has(strategyId: string): boolean;
  list(): AgentExecutionStrategy[];
  register(strategy: AgentExecutionStrategy): void;
}

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

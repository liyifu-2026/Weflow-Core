/**
 * Agent Runtime 通用契约。
 *
 * Execution Strategy 通过本契约与 Core 交互；Strategy 不得直接调用模型、
 * 数据库、Channel 或执行工具。
 */

export interface WorkStatePatch {
  [key: string]: unknown;
}

export interface HandoffBriefing {
  reasonCode: string;
  problemSummary: string;
  unresolvedItems: string[];
  suggestedFirstReply: string;
}

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
      statePatch?: WorkStatePatch;
      meta?: AgentActionMeta;
    }
  | {
      kind: "ask";
      segments: string[];
      requestedFacts: string[];
      statePatch?: WorkStatePatch;
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
      briefing: HandoffBriefing;
      meta?: AgentActionMeta;
    }
  | {
      kind: "no_action";
      reasonCode: string;
      meta?: AgentActionMeta;
    };

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools?: unknown[];
  maxTokens?: number;
}

export interface AgentStrategyContext {
  conversationId: string;
  contactId: string;
  messages: ModelMessage[];
  facts: Record<string, unknown>;
  availableTools: string[];
  profile?: unknown;
}

export interface AgentStrategyResponse {
  text: string;
  raw?: unknown;
}

export interface AgentActionValidationInput {
  action: AgentAction;
  context: AgentStrategyContext;
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
  validateAction(input: AgentActionValidationInput): AgentActionValidation;
}

export function isAgentAction(value: unknown): value is AgentAction {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "reply":
      return (
        Array.isArray(record.segments) &&
        record.segments.every((segment) => typeof segment === "string")
      );
    case "ask":
      return (
        Array.isArray(record.segments) &&
        record.segments.every((segment) => typeof segment === "string") &&
        Array.isArray(record.requestedFacts) &&
        record.requestedFacts.every((fact) => typeof fact === "string")
      );
    case "use_tool":
      return (
        typeof record.tool === "string" &&
        typeof record.arguments === "object" &&
        record.arguments !== null &&
        !Array.isArray(record.arguments)
      );
    case "handoff":
      return (
        typeof record.reasonCode === "string" &&
        typeof record.briefing === "object" &&
        record.briefing !== null
      );
    case "no_action":
      return typeof record.reasonCode === "string";
    default:
      return false;
  }
}

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
 * Optional rich metadata carried by Customer Support strategy actions.
 *
 * The base AgentAction contract stays minimal; strategies that need the full
 * decision context can attach this metadata for Core's existing downstream
 * pipeline until the old AgentDecision path is fully retired.
 */
export interface AgentActionMeta {
  intent?: string;
  stage?: string;
  missingFields?: string[];
  extractedFacts?: Record<string, string>;
  factsToStore?: Array<{
    field: string;
    subject?: string;
    value?: string;
    status: string;
    source: string;
    granularity?: string;
  }>;
  questions?: Array<{
    field: string;
    subject?: string;
    reason: string;
    requiresGranularity?: string;
  }>;
  actions?: Array<{
    action: string;
    result: string;
    subject?: string;
  }>;
  claims?: Array<{
    type: string;
    evidenceId: string;
  }>;
  activeIssueChanged?: boolean;
  requiresHuman?: boolean;
  riskLevel?: "low" | "medium" | "high";
  handoffBriefing?: {
    problemSummary: string;
    unresolvedItems: string[];
    suggestedFirstReply: string;
  };
  knowledgeQuery?: string;
  noActionReason?: string;
}

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

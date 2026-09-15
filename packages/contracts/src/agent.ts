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
      /** 说话并等待：回复发出后挂计时器，waitMs 到期对方仍未回复则唤醒续轮。 */
      waitMs?: number;
      /** 预承诺提醒话术：到点未回复时代发，不再开模型。 */
      nudgeText?: string;
      statePatch?: WorkStatePatch;
      meta?: AgentActionMeta;
    }
  | {
      kind: "ask";
      segments: string[];
      requestedFacts: string[];
      /** 追问并等待，语义同 reply.waitMs。 */
      waitMs?: number;
      nudgeText?: string;
      statePatch?: WorkStatePatch;
      meta?: AgentActionMeta;
    }
  | {
      kind: "use_tool";
      tool: string;
      arguments: Record<string, string>;
      /**
       * 工具执行前发给对方的过程性短讯（可选，≤2 条；如"稍等，我看下后台。"）。
       * 平台在落工具检查点的同一事务内先发出这些短讯，再执行工具；
       * 最终结论在工具结果回喂后的后续决策中给出。
       */
      segments?: string[];
      meta?: AgentActionMeta;
    }
  | {
      kind: "handoff";
      reasonCode: string;
      briefing: HandoffBriefing;
      /** 转接前发给对方的最后一段告别话术（可选；是否告知及措辞由策略决定）。 */
      segments?: string[];
      meta?: AgentActionMeta;
    }
  | {
      kind: "no_action";
      reasonCode: string;
      meta?: AgentActionMeta;
    }
  | {
      /** 等待对方回复：waitMs 到期由平台唤醒续轮；新入站消息会打断等待。 */
      kind: "wait";
      waitMs: number;
      /** 预承诺提醒话术：到点未回复时代发，不再开模型。 */
      nudgeText?: string;
      meta?: AgentActionMeta;
    }
  | {
      /** 收尾当前会话片段；segments 可选携带收尾话术（先发送再关闭）。 */
      kind: "end_session";
      closureSummary: string;
      segments?: string[];
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
  /** 会话类型：私聊或群聊；Strategy 可据此差异化回复策略 */
  chatType?: "private" | "group";
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

/**
 * Execution Strategy 注册表契约。
 *
 * 实现属于平台（Core 内的 `MapExecutionStrategyRegistry`）；本接口是
 * Agent Turn 执行链与 Solution Strategy 插件之间的唯一权威形状。
 */
export interface ExecutionStrategyRegistry {
  get(strategyId: string): AgentExecutionStrategy | undefined;
  has(strategyId: string): boolean;
  list(): AgentExecutionStrategy[];
  register(strategy: AgentExecutionStrategy): void;
}

export function isAgentAction(value: unknown): value is AgentAction {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "reply":
      return (
        Array.isArray(record.segments) &&
        record.segments.every((segment) => typeof segment === "string") &&
        (record.waitMs === undefined ||
          (typeof record.waitMs === "number" && Number.isFinite(record.waitMs)))
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
        !Array.isArray(record.arguments) &&
        (record.segments === undefined ||
          (Array.isArray(record.segments) &&
            record.segments.every((segment) => typeof segment === "string")))
      );
    case "handoff":
      return (
        typeof record.reasonCode === "string" &&
        typeof record.briefing === "object" &&
        record.briefing !== null &&
        (record.segments === undefined ||
          (Array.isArray(record.segments) &&
            record.segments.every((segment) => typeof segment === "string")))
      );
    case "no_action":
      return typeof record.reasonCode === "string";
    case "wait":
      return (
        typeof record.waitMs === "number" &&
        Number.isFinite(record.waitMs) &&
        (record.nudgeText === undefined || typeof record.nudgeText === "string")
      );
    case "end_session":
      return (
        typeof record.closureSummary === "string" &&
        (record.segments === undefined ||
          (Array.isArray(record.segments) &&
            record.segments.every((segment) => typeof segment === "string")))
      );
    default:
      return false;
  }
}

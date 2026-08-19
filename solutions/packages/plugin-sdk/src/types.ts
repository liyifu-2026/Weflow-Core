import type { AgentExecutionStrategy } from "@weflow/contracts";

export type PluginKind =
  | "provider"
  | "tool"
  | "skill"
  | "execution-strategy"
  | "solution-app";

export type PluginRuntimeType = "node" | "isolated" | "container";

export type PluginRestartPolicy = "always" | "on-failure" | "never";

export interface CapabilityToken {
  name: string;
  version?: string;
  scope?: string;
}

export interface PluginMetadata {
  id: string;
  name: string;
  version: string;
  publisher?: string;
  description?: string;
}

export interface PluginRuntime {
  entry: string;
  type: PluginRuntimeType;
  restartPolicy?: PluginRestartPolicy;
}

export interface PluginContext {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface PluginLifecycle {
  activate?(ctx: PluginContext): void | Promise<void>;
  deactivate?(ctx: PluginContext): void | Promise<void>;
  dispose?(ctx: PluginContext): void | Promise<void>;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface ToolRegistration {
  id: string;
  description?: string;
  parametersSchema?: unknown;
  sideEffect?: boolean;
  timeoutMs?: number;
  handler(
    args: Record<string, string>,
    ctx: PluginContext,
  ): Promise<ToolResult> | ToolResult;
}

export interface SkillRegistration {
  id: string;
  version?: string;
  beforeKnowledge?(input: unknown): unknown;
  afterKnowledge?(input: unknown): unknown;
  execute?(input: unknown, ctx: PluginContext): Promise<unknown> | unknown;
}

export interface ExecutionStrategyRegistration {
  id: string;
  version: string;
  strategy: AgentExecutionStrategy;
}

export interface RuntimePluginManifest {
  apiVersion: "weflow.io/v1";
  kind: "Plugin";
  metadata: PluginMetadata;
  runtime: PluginRuntime;
  capabilities: CapabilityToken[];
  permissions?: string[];
  tools?: ToolRegistration[];
  skills?: SkillRegistration[];
  executionStrategies?: ExecutionStrategyRegistration[];
}

export interface PluginDefinition {
  manifest: RuntimePluginManifest;
  lifecycle?: PluginLifecycle;
}

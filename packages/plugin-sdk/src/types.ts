/**
 * Plugin SDK authoring model.
 *
 * The runtime registration shapes (`PluginDefinition`, `CapabilityToken`,
 * kernel `PluginContext`) are the authoritative ones from
 * `@weflow/contracts`; they are re-exported here under their canonical names.
 * This module only owns the authoring-time package model
 * (`RuntimePluginManifest` / `PluginPackage`) used by Solution developers;
 * adapting a `PluginPackage` into a runtime `PluginDefinition` happens in the
 * platform adapter layer, never by re-declaring lookalike types.
 */
import type { AgentExecutionStrategy } from "@weflow/contracts";

// Runtime contract shapes — canonical definitions live in @weflow/contracts.
export {
  capability,
  type CapabilityToken,
  type KernelEventListener,
  type MaybePromise,
} from "@weflow/contracts";
export type PluginDefinition = import("@weflow/contracts").PluginDefinition;

/** Manifest-level capability declaration (authoring view of a token). */
export interface CapabilityDeclaration {
  /** Stable capability id, identical to the kernel token id. */
  id: string;
  version?: string;
  scope?: string;
}

export type PluginKind =
  | "provider"
  | "tool"
  | "skill"
  | "execution-strategy"
  | "solution-app";

export type PluginRuntimeType = "node" | "isolated" | "container";

export type PluginRestartPolicy = "always" | "on-failure" | "never";

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

/**
 * Authoring-time context passed to lifecycle hooks. Deliberately distinct
 * from the kernel's `PluginContext` (capability registry) — this one carries
 * deployment configuration only.
 */
export interface AuthoringPluginContext {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface PluginLifecycle {
  activate?(ctx: AuthoringPluginContext): void | Promise<void>;
  deactivate?(ctx: AuthoringPluginContext): void | Promise<void>;
  dispose?(ctx: AuthoringPluginContext): void | Promise<void>;
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
    ctx: AuthoringPluginContext,
  ): Promise<ToolResult> | ToolResult;
}

export interface SkillRegistration {
  id: string;
  version?: string;
  beforeKnowledge?(input: unknown): unknown;
  afterKnowledge?(input: unknown): unknown;
  execute?(
    input: unknown,
    ctx: AuthoringPluginContext,
  ): Promise<unknown> | unknown;
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
  capabilities: CapabilityDeclaration[];
  permissions?: string[];
  tools?: ToolRegistration[];
  skills?: SkillRegistration[];
  executionStrategies?: ExecutionStrategyRegistration[];
}

/** Authoring-time plugin package: a manifest plus optional lifecycle hooks. */
export interface PluginPackage {
  manifest: RuntimePluginManifest;
  lifecycle?: PluginLifecycle;
}

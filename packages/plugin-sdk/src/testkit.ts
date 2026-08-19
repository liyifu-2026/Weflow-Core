import { isPluginManifest } from "./guards.js";
import type {
  ExecutionStrategyRegistration,
  PluginContext,
  PluginDefinition,
  RuntimePluginManifest,
  SkillRegistration,
  ToolRegistration,
} from "./types.js";

export interface PluginHarness {
  manifest: RuntimePluginManifest;
  tools: Map<string, ToolRegistration>;
  skills: Map<string, SkillRegistration>;
  strategies: Map<string, ExecutionStrategyRegistration>;
  activate(ctx: PluginContext): Promise<void>;
  deactivate(ctx: PluginContext): Promise<void>;
  dispose(ctx: PluginContext): Promise<void>;
}

export function createPluginHarness(plugin: PluginDefinition): PluginHarness {
  if (!isPluginManifest(plugin.manifest)) {
    throw new Error("invalid plugin manifest");
  }

  const tools = new Map<string, ToolRegistration>();
  for (const tool of plugin.manifest.tools ?? []) {
    tools.set(tool.id, tool);
  }

  const skills = new Map<string, SkillRegistration>();
  for (const skill of plugin.manifest.skills ?? []) {
    skills.set(skill.id, skill);
  }

  const strategies = new Map<string, ExecutionStrategyRegistration>();
  for (const strategy of plugin.manifest.executionStrategies ?? []) {
    strategies.set(strategy.id, strategy);
  }

  const lifecycle = plugin.lifecycle ?? {};

  return {
    manifest: plugin.manifest,
    tools,
    skills,
    strategies,
    activate: async (ctx) => {
      await lifecycle.activate?.(ctx);
    },
    deactivate: async (ctx) => {
      await lifecycle.deactivate?.(ctx);
    },
    dispose: async (ctx) => {
      await lifecycle.dispose?.(ctx);
    },
  };
}

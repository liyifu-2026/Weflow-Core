import type { PluginDefinition } from "./types.js";

/**
 * 类型安全的 Plugin 定义入口。运行时只做透传，便于未来加入静态校验。
 */
export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin;
}

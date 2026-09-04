/**
 * Discovers agent plugin modules from the fixed plugin directory（R3）.
 *
 * Loads `<WEFLOW_PLUGIN_DIR>/plugins/<name>/dist/index.js` for every plugin
 * subdirectory that exists. Modules export `{ skill }`, `{ strategy }`,
 * `{ createStrategy }` (consumed only by the Agent Worker). A broken plugin
 * module is captured as `error` and skipped; the caller decides whether that
 * degrades or aborts startup.
 *
 * `SKILL_PLUGIN_PATH` / `STRATEGY_PLUGIN_PATH` remain supported by the
 * caller as explicit overrides; this discovery runs only when neither is set.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePluginDirRoot } from "./backend-plugin-loader.js";

export type DiscoveredAgentPlugin = {
  artifactId: string;
  url: string;
  module?: unknown;
  error?: unknown;
};

/** 插件 dist 入口候选：先打包产物 plugin.js，再 tsc 产物 index.js */
function resolvePluginEntry(pluginDir: string): string | null {
  const bundled = join(pluginDir, "dist", "plugin.js");
  if (existsSync(bundled)) return bundled;
  const compiled = join(pluginDir, "dist", "index.js");
  if (existsSync(compiled)) return compiled;
  return null;
}

export async function discoverAgentPlugins(): Promise<DiscoveredAgentPlugin[]> {
  const discovered: DiscoveredAgentPlugin[] = [];
  const pluginRoot = resolvePluginDirRoot();
  if (!pluginRoot) return discovered;
  const pluginsDir = join(pluginRoot, "plugins");
  if (!existsSync(pluginsDir)) return discovered;
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryFile = resolvePluginEntry(join(pluginsDir, entry.name));
    if (!entryFile) continue;
    const url = pathToFileURL(entryFile).href;
    try {
      const module = (await import(url)) as unknown;
      discovered.push({ artifactId: entry.name, url, module });
    } catch (error) {
      discovered.push({ artifactId: entry.name, url, error });
    }
  }
  return discovered;
}

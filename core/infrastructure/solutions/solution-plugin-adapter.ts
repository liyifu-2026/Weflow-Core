/**
 * Adapts a structural Solution plugin to the Core RuntimeKernel plugin shape.
 *
 * Solution plugins intentionally avoid importing Core internals; this adapter
 * is the only place that maps string capability ids to Core capability tokens.
 */
import { capability, type PluginDefinition } from "../runtime/kernel/index.js";
import type { LoadedSolutionPlugin } from "./solution-plugin-loader.js";

export function adaptSolutionPlugin(
  loaded: LoadedSolutionPlugin,
): PluginDefinition {
  const providedTokens = new Map(
    loaded.plugin.manifest.provides.map((id) => [id, capability(id)] as const),
  );
  const requiredTokens = new Map(
    loaded.plugin.manifest.requires.map((id) => [id, capability(id)] as const),
  );

  return {
    name: loaded.id,
    provides: [...providedTokens.values()],
    requires: [...requiredTokens.values()],
    setup(context) {
      return loaded.plugin.setup?.({
        provide: (capabilityId, value) => {
          const token = providedTokens.get(capabilityId);
          if (!token) {
            throw new Error(
              `solution_plugin_undeclared_provide:${loaded.id}:${capabilityId}`,
            );
          }
          context.provide(token, value);
        },
        use: (capabilityId: string): unknown => {
          const token = requiredTokens.get(capabilityId);
          if (!token) {
            throw new Error(
              `solution_plugin_undeclared_require:${loaded.id}:${capabilityId}`,
            );
          }
          return context.use(token);
        },
      });
    },
  };
}

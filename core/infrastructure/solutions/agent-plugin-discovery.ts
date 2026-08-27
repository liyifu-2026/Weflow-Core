/**
 * Discovers agent plugin modules from the managed Solution Store.
 *
 * Mirrors solution-plugin-loader.ts, but for artifacts declared with
 * `targetProcess: "agent-worker"`: those plugins export `{ strategy }`,
 * `{ createStrategy }` or `{ skill }` (consumed only by the Agent Worker)
 * instead of the Solution Plugin contract, so the core-side loader must
 * skip them. Importing always resolves through the store's `active`
 * junctions — upgrading a solution therefore upgrades the worker's
 * strategies/skills without configuration changes. A broken plugin module
 * is captured as `error` and skipped; the caller decides whether that
 * degrades or aborts startup.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  describeSolution,
  type SolutionManifestV1,
} from "@weflow-leaif/solution-sdk";
import { artifactKind, normalizeRef, readManifestFile } from "./solution-stage.js";
import { resolveActiveSolutionDir, storeSolutions } from "./solution-store.js";

export type AgentPluginTargetedArtifact = SolutionManifestV1["artifacts"][number] & {
  targetProcess?: unknown;
};

export type DiscoveredAgentPlugin = {
  artifactId: string;
  url: string;
  module?: unknown;
  error?: unknown;
};

export async function discoverAgentPlugins(): Promise<DiscoveredAgentPlugin[]> {
  const discovered: DiscoveredAgentPlugin[] = [];
  for (const solutionId of await storeSolutions()) {
    const activeRoot = await resolveActiveSolutionDir(solutionId);
    if (!activeRoot) continue;
    let manifest: SolutionManifestV1;
    try {
      manifest = describeSolution(await readManifestFile(activeRoot)).manifest;
    } catch {
      // A corrupt active manifest is a store-health problem (see
      // `weflowctl solution doctor`); loading must not hard-fail the worker.
      continue;
    }
    for (const artifact of manifest.artifacts) {
      if (artifactKind(artifact) !== "plugin") continue;
      if ((artifact as AgentPluginTargetedArtifact).targetProcess !== "agent-worker") {
        continue;
      }
      const url = pathToFileURL(
        join(activeRoot, normalizeRef(artifact.ref), "dist", "plugin.js"),
      ).href;
      try {
        const module = (await import(url)) as unknown;
        discovered.push({ artifactId: artifact.id, url, module });
      } catch (error) {
        discovered.push({ artifactId: artifact.id, url, error });
      }
    }
  }
  return discovered;
}

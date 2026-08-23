/**
 * Loads solution plugin code artifacts from the managed Solution Store.
 *
 * The loader intentionally stays small: it enumerates the store's `active`
 * junctions, validates each active manifest against the SDK contract, and
 * dynamically imports the bundled `dist/plugin.js`. Solutions without an
 * activated store version are skipped — production must activate a version
 * through `weflowctl solution install/activate` first; there is no source-tree
 * fallback and the Core database is never consulted. The store lockfile and
 * the `active` junctions are the single source of installation truth.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  describeSolution,
  type SolutionManifestV1,
} from "@weflow/solution-sdk";
import { readManifestFile } from "./solution-stage.js";
import { resolveActiveSolutionDir, storeSolutions } from "./solution-store.js";

export type LoadedSolutionPlugin = {
  artifactId: string;
  id: string;
  plugin: {
    manifest: {
      id: string;
      version: string;
      sdkVersion: string;
      provides: string[];
      requires: string[];
      permissions: string[];
    };
    setup?: (context: {
      provide(capabilityId: string, value: unknown): void;
      use(capabilityId: string): unknown;
    }) => void | Promise<void>;
    start?: (context: unknown) => void | Promise<void>;
    stop?: (context: unknown) => void | Promise<void>;
  };
};

/** Loose shape of a bundled `dist/plugin.js` module before validation. */
type SolutionPluginModule = {
  manifest?: LoadedSolutionPlugin["plugin"]["manifest"];
  setup?: LoadedSolutionPlugin["plugin"]["setup"];
  start?: LoadedSolutionPlugin["plugin"]["start"];
  stop?: LoadedSolutionPlugin["plugin"]["stop"];
};

export async function loadInstalledSolutionPlugins(): Promise<
  LoadedSolutionPlugin[]
> {
  const loaded: LoadedSolutionPlugin[] = [];
  for (const solutionId of await storeSolutions()) {
    const activeRoot = await resolveActiveSolutionDir(solutionId);
    if (!activeRoot) continue;
    let manifest: SolutionManifestV1;
    try {
      manifest = describeSolution(await readManifestFile(activeRoot)).manifest;
    } catch {
      // A corrupt active manifest is a store-health problem (see
      // `weflowctl solution doctor`); loading must not hard-fail the process.
      continue;
    }
    for (const artifact of manifest.artifacts) {
      if (artifactKind(artifact) !== "plugin") continue;
      const absolutePath = resolveSolutionRef(activeRoot, artifact.ref);
      const moduleUrl = pathToFileURL(`${absolutePath}/dist/plugin.js`).href;
      // The imported module is untrusted runtime data; narrow defensively.
      const module = (await import(moduleUrl)) as {
        plugin?: SolutionPluginModule;
        default?: SolutionPluginModule;
      };
      const candidate = module.plugin ?? module.default;
      if (!candidate || typeof candidate.manifest?.id !== "string") {
        throw new Error(
          `solution_plugin_invalid:${artifact.id}:missing_plugin_export`,
        );
      }
      loaded.push({
        artifactId: artifact.id,
        id: candidate.manifest.id,
        plugin: {
          manifest: candidate.manifest,
          ...(candidate.setup ? { setup: candidate.setup } : {}),
          ...(candidate.start ? { start: candidate.start } : {}),
          ...(candidate.stop ? { stop: candidate.stop } : {}),
        },
      });
    }
  }
  return loaded;
}

function artifactKind(
  artifact: SolutionManifestV1["artifacts"][number],
): string | null {
  const fields = artifact as { kind?: unknown; type?: unknown };
  if (typeof fields.kind === "string" && fields.kind.length > 0) {
    return fields.kind;
  }
  if (fields.type === "plugin") return "plugin";
  return null;
}

function resolveSolutionRef(solutionRoot: string, ref: string): string {
  const cleaned = ref.startsWith("file:") ? ref.slice("file:".length) : ref;
  return resolve(solutionRoot, cleaned);
}

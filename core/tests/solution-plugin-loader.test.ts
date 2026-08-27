import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateSolution,
  installSolutionToStore,
} from "../infrastructure/solutions/solution-store.js";
import {
  discoverAgentPlugins,
} from "../infrastructure/solutions/agent-plugin-discovery.js";
import { loadInstalledSolutionPlugins } from "../infrastructure/solutions/solution-plugin-loader.js";

let root: string;
let previousStore: string | undefined;

function mixedManifest(solutionId: string, version: string): unknown {
  return {
    apiVersion: "weflow.io/v1",
    kind: "Solution",
    metadata: {
      id: solutionId,
      name: "Mixed",
      version,
      publisher: "weflow",
    },
    compatibility: { platform: ">=1.0.0 <2.0.0", pluginSdk: "^1.0.0" },
    dependencies: { capabilities: [], solutions: [] },
    artifacts: [
      {
        id: "core-plugin",
        kind: "plugin",
        ref: "file:./plugins/core-plugin",
      },
      {
        id: "agent-strategy",
        kind: "plugin",
        ref: "file:./plugins/agent-strategy",
        targetProcess: "agent-worker",
      },
    ],
    permissions: [],
    configuration: { defaults: {} },
    secretSlots: [],
    resources: [],
    executionProfiles: [],
    applications: [],
    healthChecks: [],
  };
}

beforeEach(async () => {
  root = await mkdtempFixture();
  previousStore = process.env.WEFLOW_SOLUTION_STORE;
  process.env.WEFLOW_SOLUTION_STORE = root;
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.WEFLOW_SOLUTION_STORE;
  else process.env.WEFLOW_SOLUTION_STORE = previousStore;
  await rm(root, { recursive: true, force: true });
});

async function mkdtempFixture(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "weflow-plugin-loader-"));
}

/**
 * A solution shipping both kinds of plugin artifacts: a platform Solution
 * Plugin (`{ plugin }` export, owned by the core loader) and an agent
 * plugin (`{ strategy }` / `{ skill }` exports, owned by the Agent Worker).
 */
async function writeMixedSolution(): Promise<void> {
  const source = join(root, "source");
  await mkdir(join(source, "plugins", "core-plugin", "src"), {
    recursive: true,
  });
  await mkdir(join(source, "plugins", "agent-strategy", "src"), {
    recursive: true,
  });
  await writeFile(
    join(source, "solution.manifest.json"),
    JSON.stringify(mixedManifest("weflow.mixed", "1.0.0")),
  );
  await writeFile(
    join(source, "plugins", "core-plugin", "src", "plugin.ts"),
    'export const plugin = { manifest: { id: "test.core-plugin" } };\n',
  );
  await writeFile(
    join(source, "plugins", "agent-strategy", "src", "plugin.ts"),
    'export const strategy = {};\nexport const skill = {};\n',
  );
  await installSolutionToStore(source, "weflow.mixed", "1.0.0", "sha256:abc");
  await activateSolution("weflow.mixed", "1.0.0");
}

describe("solution plugin ownership routing", () => {
  it("loads only core-owned plugin exports through the platform loader", async () => {
    await writeMixedSolution();

    // Must not throw `missing_plugin_export` for the agent plugin.
    const loaded = await loadInstalledSolutionPlugins();
    expect(loaded.map((item) => item.artifactId)).toEqual(["core-plugin"]);
    expect(loaded[0]?.id).toBe("test.core-plugin");
  });

  it("discovers agent-worker targeted plugins for the worker", async () => {
    await writeMixedSolution();

    const discovered = await discoverAgentPlugins();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.artifactId).toBe("agent-strategy");
    expect(discovered[0]?.error).toBeUndefined();
    const module = discovered[0]?.module as Record<string, unknown>;
    expect(module.strategy).toBeDefined();
    expect(module.skill).toBeDefined();
  });

  it("reports broken agent plugin modules instead of throwing", async () => {
    await writeMixedSolution();
    // Overwrite the bundled entry with invalid ESM.
    await writeFile(
      join(
        root,
        "weflow.mixed",
        "1.0.0",
        "plugins",
        "agent-strategy",
        "dist",
        "plugin.js",
      ),
      "export default syntax error {{{",
    );

    const discovered = await discoverAgentPlugins();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.module).toBeUndefined();
    expect(discovered[0]?.error).toBeDefined();
  });
});

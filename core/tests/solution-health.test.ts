import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSolutionVersionHealth } from "../infrastructure/solutions/solution-health.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weflow-health-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const DEMO_MANIFEST = {
  apiVersion: "weflow.io/v1",
  kind: "Solution",
  metadata: {
    id: "weflow.demo",
    name: "Demo",
    version: "1.0.0",
    publisher: "weflow",
  },
  compatibility: { platform: ">=1.0.0 <2.0.0", pluginSdk: "^1.0.0" },
  dependencies: { capabilities: [], solutions: [] },
  artifacts: [
    { id: "demo-plugin", kind: "plugin", ref: "file:./plugins/demo" },
  ],
  permissions: [],
  configuration: { defaults: {} },
  secretSlots: [],
  resources: [],
  executionProfiles: [],
  applications: [],
  healthChecks: [],
};

describe("checkSolutionVersionHealth", () => {
  it("passes for a complete staged version directory", async () => {
    const dir = join(root, "1.0.0");
    await mkdir(join(dir, "plugins", "demo", "dist"), { recursive: true });
    await writeFile(
      join(dir, "solution.manifest.json"),
      JSON.stringify(DEMO_MANIFEST),
    );
    await writeFile(join(dir, "plugins", "demo", "dist", "plugin.js"), "x");

    await expect(checkSolutionVersionHealth(dir)).resolves.toEqual({
      ok: true,
    });
  });

  it("fails when the manifest cannot be parsed", async () => {
    const dir = join(root, "1.0.0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "solution.manifest.json"), "{}");

    const result = await checkSolutionVersionHealth(dir);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toContain("solution_manifest_invalid");
  });

  it("fails when the manifest is missing entirely", async () => {
    const dir = join(root, "1.0.0");
    await mkdir(dir, { recursive: true });

    const result = await checkSolutionVersionHealth(dir);
    expect(result.ok).toBe(false);
  });

  it("fails when a declared plugin artifact has no bundled entry point", async () => {
    const dir = join(root, "1.0.0");
    await mkdir(join(dir, "plugins", "demo"), { recursive: true });
    await writeFile(
      join(dir, "solution.manifest.json"),
      JSON.stringify(DEMO_MANIFEST),
    );

    const result = await checkSolutionVersionHealth(dir);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toContain("plugin_entry_missing:demo-plugin");
  });

  it("runs the extra checker and reports its failure", async () => {
    const dir = join(root, "1.0.0");
    await mkdir(join(dir, "plugins", "demo", "dist"), { recursive: true });
    await writeFile(
      join(dir, "solution.manifest.json"),
      JSON.stringify(DEMO_MANIFEST),
    );
    await writeFile(join(dir, "plugins", "demo", "dist", "plugin.js"), "x");

    const result = await checkSolutionVersionHealth(dir, () =>
      Promise.resolve({ ok: false, reason: "runtime_probe_failed" }),
    );
    expect(result).toEqual({ ok: false, reason: "runtime_probe_failed" });
  });
});

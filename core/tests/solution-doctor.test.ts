import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSolutionDoctor } from "../infrastructure/solutions/solution-doctor.js";

let root: string;
let previousStore: string | undefined;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weflow-doctor-"));
  previousStore = process.env.WEFLOW_SOLUTION_STORE;
  previousHome = process.env.WEFLOW_HOME;
  process.env.WEFLOW_SOLUTION_STORE = join(root, "store");
  process.env.WEFLOW_HOME = join(root, "home");
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.WEFLOW_SOLUTION_STORE;
  else process.env.WEFLOW_SOLUTION_STORE = previousStore;
  if (previousHome === undefined) delete process.env.WEFLOW_HOME;
  else process.env.WEFLOW_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

function demoManifest(version: string): unknown {
  return {
    apiVersion: "weflow.io/v1",
    kind: "Solution",
    metadata: {
      id: "weflow.demo",
      name: "Demo",
      version,
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
}

async function installDemo(version: string): Promise<void> {
  const source = join(root, `source-${version}`);
  await mkdir(join(source, "plugins", "demo", "dist"), { recursive: true });
  await writeFile(
    join(source, "solution.manifest.json"),
    JSON.stringify(demoManifest(version)),
  );
  await writeFile(
    join(source, "plugins", "demo", "dist", "plugin.js"),
    "export const plugin = {};",
  );
  const { installSolutionToStore } =
    await import("../infrastructure/solutions/solution-store.js");
  await installSolutionToStore(
    source,
    "weflow.demo",
    version,
    `sha256:${version}`,
  );
}

describe("solution doctor", () => {
  it("reports a healthy store with an activated verified package", async () => {
    const { generateSigningKey } =
      await import("../infrastructure/solutions/solution-pack.js");
    const { defaultDevSigningKeyPath } =
      await import("../infrastructure/solutions/solution-pack.js");
    await generateSigningKey(defaultDevSigningKeyPath());
    await installDemo("1.0.0");
    const { activateSolution } =
      await import("../infrastructure/solutions/solution-store.js");
    await activateSolution("weflow.demo", "1.0.0");

    const report = await runSolutionDoctor();
    expect(report.ok).toBe(true);
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    expect(byId.get("store_root")?.ok).toBe(true);
    expect(byId.get("lockfile")?.ok).toBe(true);
    expect(byId.get("active_junction")?.ok).toBe(true);
    expect(byId.get("signature")?.ok).toBe(true);
  });

  it("fails store_root when the directory does not exist and suggests init", async () => {
    const report = await runSolutionDoctor();
    expect(report.ok).toBe(false);
    const storeRoot = report.checks.find((check) => check.id === "store_root");
    expect(storeRoot?.ok).toBe(false);
    expect(storeRoot?.hint).toBeTruthy();
  });

  it("detects a broken active junction", async () => {
    await installDemo("1.0.0");
    const { activateSolution } =
      await import("../infrastructure/solutions/solution-store.js");
    await activateSolution("weflow.demo", "1.0.0");
    // Break the junction by removing its target.
    const storeRoot = process.env.WEFLOW_SOLUTION_STORE;
    if (!storeRoot) throw new Error("store env missing");
    const target = join(storeRoot, "weflow.demo", "1.0.0");
    await rm(target, { recursive: true, force: true });

    const report = await runSolutionDoctor();
    const junction = report.checks.find(
      (check) => check.id === "active_junction",
    );
    expect(junction?.ok).toBe(false);
  });

  it("flags installed versions whose signature cannot be verified", async () => {
    await installDemo("1.0.0");
    // No signing key exists in WEFLOW_HOME -> signature unverifiable.
    const report = await runSolutionDoctor();
    const signature = report.checks.find((check) => check.id === "signature");
    expect(signature?.ok).toBe(false);
  });

  it("probes the registry only when configured", async () => {
    const withoutRegistry = await runSolutionDoctor({ registryUrl: undefined });
    expect(
      withoutRegistry.checks.find((check) => check.id === "registry"),
    ).toBeUndefined();

    const report = await runSolutionDoctor({
      registryUrl: "http://127.0.0.1:9",
      fetchImpl: () => Promise.reject(new Error("fetch failed")),
    });
    const registry = report.checks.find((check) => check.id === "registry");
    expect(registry?.ok).toBe(false);
  });

  it("reports orphan versions present in the filesystem but missing from the lockfile", async () => {
    await installDemo("1.0.0");
    const orphanStoreRoot = process.env.WEFLOW_SOLUTION_STORE;
    if (!orphanStoreRoot) throw new Error("store env missing");
    const orphanDir = join(orphanStoreRoot, "weflow.orphan", "9.9.9");
    await mkdir(orphanDir, { recursive: true });
    await writeFile(join(orphanDir, "stray.txt"), "?");

    const report = await runSolutionDoctor();
    const orphans = report.checks.find((check) => check.id === "orphans");
    expect(orphans?.ok).toBe(false);
    expect(JSON.stringify(orphans?.detail ?? {})).toContain("weflow.orphan");
  });
});

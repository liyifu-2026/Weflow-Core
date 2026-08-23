import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectPackage } from "../infrastructure/solutions/solution-inspect.js";
import { packSolution } from "../infrastructure/solutions/solution-pack.js";

let root: string;
let previousStore: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weflow-inspect-"));
  previousStore = process.env.WEFLOW_SOLUTION_STORE;
  process.env.WEFLOW_SOLUTION_STORE = join(root, "store");
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.WEFLOW_SOLUTION_STORE;
  else process.env.WEFLOW_SOLUTION_STORE = previousStore;
  await rm(root, { recursive: true, force: true });
});

async function packDemo(): Promise<string> {
  const source = join(root, "source");
  await mkdir(join(source, "plugins", "demo", "dist"), { recursive: true });
  await mkdir(join(source, "resources"), { recursive: true });
  await writeFile(
    join(source, "solution.manifest.json"),
    JSON.stringify({
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
      applications: [{ id: "web", kind: "web", entry: "apps/web" }],
      healthChecks: [],
    }),
  );
  await writeFile(
    join(source, "plugins", "demo", "dist", "plugin.js"),
    "export const plugin = {};",
  );
  const packed = await packSolution({
    sourceDir: source,
    outDir: join(root, "dist"),
    privateKeyPemPath: join(root, "keys", "dev.pem"),
    keyId: "inspect-test",
  });
  return packed.tgzPath;
}

describe("inspectPackage", () => {
  it("inspects a tgz without touching the store", async () => {
    const tgzPath = await packDemo();
    const report = await inspectPackage(tgzPath);

    expect(report.solutionId).toBe("weflow.demo");
    expect(report.version).toBe("1.0.0");
    expect(report.signature.keyId).toBe("inspect-test");
    expect(report.files.map((item) => item.path)).toContain(
      "solution.manifest.json",
    );
    const bundle = report.files.find((item) =>
      item.path.endsWith("plugins/demo/dist/plugin.js"),
    );
    expect(bundle?.size).toBeGreaterThan(0);
    expect(report.totalSize).toBeGreaterThan(0);
    expect(report.applications).toEqual(["web"]);
  });

  it("inspects a package directory too", async () => {
    const tgzPath = await packDemo();
    const dir = await (
      await import("../infrastructure/solutions/solution-pack.js")
    ).extractSolutionTgz(tgzPath, join(root, "extracted"));

    const report = await inspectPackage(dir);
    expect(report.solutionId).toBe("weflow.demo");
    expect(report.lock?.resolvedArtifacts.length).toBe(1);
  });

  it("fails loudly for a directory without a manifest", async () => {
    const empty = join(root, "empty");
    await mkdir(empty, { recursive: true });
    await expect(inspectPackage(empty)).rejects.toThrow(
      "solution_manifest_not_found",
    );
  });
});

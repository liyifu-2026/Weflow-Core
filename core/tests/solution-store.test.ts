import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateSolution,
  deactivateSolution,
  getSolutionStoreRoot,
  installSolutionToStore,
  listInstalledVersions,
  pruneSolutionVersions,
  readActiveVersion,
  readActivationHistory,
  readSolutionLockfile,
  removeSolution,
  resolveActiveSolutionDir,
  rollbackSolution,
} from "../infrastructure/solutions/solution-store.js";

let root: string;
let previousStore: string | undefined;

function demoManifest(solutionId: string, version: string): unknown {
  return {
    apiVersion: "weflow.io/v1",
    kind: "Solution",
    metadata: {
      id: solutionId,
      name: "Demo",
      version,
      publisher: "weflow",
    },
    compatibility: { platform: ">=1.0.0 <2.0.0", pluginSdk: "^1.0.0" },
    dependencies: { capabilities: [], solutions: [] },
    artifacts: [
      { id: "demo-plugin", type: "plugin", ref: "file:./plugins/demo" },
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

async function writeDemoPlugin(source: string, marker?: string): Promise<void> {
  await mkdir(join(source, "plugins", "demo", "src"), { recursive: true });
  await writeFile(
    join(source, "plugins", "demo", "src", "plugin.ts"),
    marker
      ? `export const pluginMarker = ${JSON.stringify(marker)};\nexport const plugin = {};\n`
      : "export const plugin = {};\n",
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weflow-store-"));
  previousStore = process.env.WEFLOW_SOLUTION_STORE;
  process.env.WEFLOW_SOLUTION_STORE = root;
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.WEFLOW_SOLUTION_STORE;
  else process.env.WEFLOW_SOLUTION_STORE = previousStore;
  await rm(root, { recursive: true, force: true });
});

describe("solution store", () => {
  it("installs a versioned package and writes the lockfile", async () => {
    const source = join(root, "source");
    await writeDemoPlugin(source);
    await writeFile(
      join(source, "solution.manifest.json"),
      JSON.stringify(demoManifest("weflow.customer-support", "1.0.0")),
    );

    const dest = await installSolutionToStore(
      source,
      "weflow.customer-support",
      "1.0.0",
      "sha256:abc",
    );

    expect(dest).toContain("weflow.customer-support");
    const lock = await readSolutionLockfile();
    expect(lock.solutions).toContainEqual(
      expect.objectContaining({
        solutionId: "weflow.customer-support",
        version: "1.0.0",
        manifestDigest: "sha256:abc",
      }),
    );
  });

  it("activates a version and resolves it through the active junction", async () => {
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "marker.txt"), "v1");
    await writeDemoPlugin(source);
    await writeFile(
      join(source, "solution.manifest.json"),
      JSON.stringify(demoManifest("weflow.customer-support", "1.0.0")),
    );

    await installSolutionToStore(
      source,
      "weflow.customer-support",
      "1.0.0",
      "sha256:abc",
    );
    await activateSolution("weflow.customer-support", "1.0.0");

    const activeDir = await resolveActiveSolutionDir("weflow.customer-support");
    expect(activeDir).not.toBeNull();
    expect(getSolutionStoreRoot()).toBe(root);
    await expect(readActiveVersion("weflow.customer-support")).resolves.toBe(
      "1.0.0",
    );
  });

  it("lists installed versions in semver order", async () => {
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "marker.txt"), "v1");
    await writeDemoPlugin(source);
    for (const version of ["1.0.0", "1.2.0", "1.10.0", "1.1.0"]) {
      await writeFile(
        join(source, "solution.manifest.json"),
        JSON.stringify(demoManifest("weflow.demo", version)),
      );
      await installSolutionToStore(
        source,
        "weflow.demo",
        version,
        "sha256:abc",
      );
    }

    await expect(listInstalledVersions("weflow.demo")).resolves.toEqual([
      "1.0.0",
      "1.1.0",
      "1.2.0",
      "1.10.0",
    ]);
    await expect(listInstalledVersions("weflow.missing")).resolves.toEqual([]);
  });

  it("rolls back to the previously active version", async () => {
    const source = join(root, "source");
    await writeDemoPlugin(source, "one");
    await writeFile(
      join(source, "solution.manifest.json"),
      JSON.stringify(demoManifest("weflow.demo", "1.0.0")),
    );
    await installSolutionToStore(source, "weflow.demo", "1.0.0", "sha256:a");
    await writeFile(
      join(source, "plugins", "demo", "src", "plugin.ts"),
      'export const pluginMarker = "two";\nexport const plugin = {};\n',
    );
    await writeFile(
      join(source, "solution.manifest.json"),
      JSON.stringify(demoManifest("weflow.demo", "1.1.0")),
    );
    await installSolutionToStore(source, "weflow.demo", "1.1.0", "sha256:b");
    await activateSolution("weflow.demo", "1.0.0");
    await activateSolution("weflow.demo", "1.1.0");

    const result = await rollbackSolution("weflow.demo");
    expect(result).toEqual({ from: "1.1.0", to: "1.0.0" });
    await expect(readActiveVersion("weflow.demo")).resolves.toBe("1.0.0");
  });

  it("refuses to roll back when there is no previous version", async () => {
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "marker.txt"), "v1");
    await writeDemoPlugin(source);
    await writeFile(
      join(source, "solution.manifest.json"),
      JSON.stringify(demoManifest("weflow.demo", "1.0.0")),
    );

    await installSolutionToStore(source, "weflow.demo", "1.0.0", "sha256:a");
    await activateSolution("weflow.demo", "1.0.0");

    await expect(rollbackSolution("weflow.demo")).rejects.toThrow(
      "solution_no_previous_version",
    );
  });

  it("refuses to roll back when nothing is active", async () => {
    await expect(rollbackSolution("weflow.never-installed")).rejects.toThrow(
      "solution_not_active",
    );
  });

  it("installs self-contained packages without workspace dependency hacks", async () => {
    const source = join(root, "source");
    await mkdir(join(source, "plugins", "demo", "src"), { recursive: true });
    await writeFile(
      join(source, "solution.manifest.json"),
      JSON.stringify(demoManifest("weflow.demo", "1.0.0")),
    );
    await writeFile(
      join(source, "plugins", "demo", "src", "plugin.ts"),
      'export const pluginMarker = "store-bundle-marker";\nexport const plugin = {};\n',
    );

    await installSolutionToStore(source, "weflow.demo", "1.0.0", "sha256:a");

    const versionDir = join(root, "weflow.demo", "1.0.0");
    const bundle = await readFile(
      join(versionDir, "plugins", "demo", "dist", "plugin.js"),
      "utf8",
    );
    expect(bundle).toContain("store-bundle-marker");
    await expect(stat(join(versionDir, "node_modules"))).rejects.toThrow();
  });

  it("deactivates by removing the active junction while keeping files", async () => {
    const source = join(root, "source");
    await writeDemoPlugin(source);
    await writeFile(
      join(source, "solution.manifest.json"),
      JSON.stringify(demoManifest("weflow.customer-support", "1.0.0")),
    );
    await installSolutionToStore(
      source,
      "weflow.customer-support",
      "1.0.0",
      "sha256:a",
    );
    await activateSolution("weflow.customer-support", "1.0.0");

    const deactivated = await deactivateSolution("weflow.customer-support");
    expect(deactivated).toBe(true);
    await expect(
      readActiveVersion("weflow.customer-support"),
    ).resolves.toBeNull();
    // Files stay in place.
    expect(await listInstalledVersions("weflow.customer-support")).toEqual([
      "1.0.0",
    ]);
    // Deactivating again is a no-op.
    await expect(deactivateSolution("weflow.customer-support")).resolves.toBe(
      false,
    );
  });

  it("removes a solution completely from the store and lockfile", async () => {
    const source = join(root, "source");
    for (const version of ["1.0.0", "1.1.0"]) {
      await writeDemoPlugin(source);
      await writeFile(
        join(source, "solution.manifest.json"),
        JSON.stringify(demoManifest("weflow.demo", version)),
      );
      await installSolutionToStore(
        source,
        "weflow.demo",
        version,
        `sha256:${version}`,
      );
    }
    await activateSolution("weflow.demo", "1.1.0");

    const result = await removeSolution("weflow.demo");
    expect(result.removedVersions).toEqual(["1.0.0", "1.1.0"]);
    expect(await listInstalledVersions("weflow.demo")).toEqual([]);
    await expect(readActiveVersion("weflow.demo")).resolves.toBeNull();
    const lock = await readSolutionLockfile();
    expect(
      lock.solutions.filter((item) => item.solutionId === "weflow.demo"),
    ).toEqual([]);
    expect(
      (lock.activations ?? []).filter(
        (item) => item.solutionId === "weflow.demo",
      ),
    ).toEqual([]);
  });

  it("reads the activation history newest-first", async () => {
    const source = join(root, "source");
    await writeDemoPlugin(source);
    for (const version of ["1.0.0", "1.1.0"]) {
      await writeFile(
        join(source, "solution.manifest.json"),
        JSON.stringify(demoManifest("weflow.demo", version)),
      );
      await installSolutionToStore(source, "weflow.demo", version, "sha256:x");
    }
    await activateSolution("weflow.demo", "1.0.0");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await activateSolution("weflow.demo", "1.1.0");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await rollbackSolution("weflow.demo");

    const history = await readActivationHistory("weflow.demo");
    expect(history[0]?.version).toBe("1.0.0"); // rollback re-activated 1.0.0
    expect(history.map((item) => item.version)).toContain("1.1.0");
    expect(history.every((item) => typeof item.activatedAt === "string")).toBe(
      true,
    );
  });

  it("prunes old versions keeping the active one and the newest N", async () => {
    const source = join(root, "source");
    for (const version of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
      await writeDemoPlugin(source);
      await writeFile(
        join(source, "solution.manifest.json"),
        JSON.stringify(demoManifest("weflow.demo", version)),
      );
      await installSolutionToStore(source, "weflow.demo", version, "sha256:x");
    }
    await activateSolution("weflow.demo", "1.0.0"); // active but oldest

    const result = await pruneSolutionVersions("weflow.demo", 2);
    expect(result.kept).toEqual(
      expect.arrayContaining(["1.3.0", "1.2.0", "1.0.0"]),
    );
    expect(result.removed).toEqual(["1.1.0"]);
    expect(await listInstalledVersions("weflow.demo")).toEqual([
      "1.0.0",
      "1.2.0",
      "1.3.0",
    ]);
    await expect(readActiveVersion("weflow.demo")).resolves.toBe("1.0.0");
  });
});

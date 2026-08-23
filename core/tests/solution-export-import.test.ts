import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportSolutionBackup,
  importSolutionBackup,
} from "../infrastructure/solutions/solution-export-import.js";
import {
  activateSolution,
  listInstalledVersions,
  readActiveVersion,
} from "../infrastructure/solutions/solution-store.js";

let root: string;
let previousStore: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weflow-export-"));
  previousStore = process.env.WEFLOW_SOLUTION_STORE;
  process.env.WEFLOW_SOLUTION_STORE = join(root, "store");
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.WEFLOW_SOLUTION_STORE;
  else process.env.WEFLOW_SOLUTION_STORE = previousStore;
  await rm(root, { recursive: true, force: true });
});

async function installSigned(version: string): Promise<void> {
  // Produce a properly signed package so import can verify it.
  const { packSolution } =
    await import("../infrastructure/solutions/solution-pack.js");
  const source = join(root, `source-${version}`);
  await mkdir(join(source, "plugins", "demo", "dist"), { recursive: true });
  await writeFile(
    join(source, "solution.manifest.json"),
    JSON.stringify({
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
    }),
  );
  await writeFile(
    join(source, "plugins", "demo", "dist", "plugin.js"),
    `export const bundledVersion = ${JSON.stringify(version)};\nexport const plugin = {};`,
  );
  const packed = await packSolution({
    sourceDir: source,
    outDir: join(root, "dist"),
    privateKeyPemPath: join(root, "keys", "dev.pem"),
    keyId: "export-test",
  });
  const { installSolutionPackage } =
    await import("../infrastructure/solutions/solution-pack.js");
  const trustedPublicKeyPem = await (
    await import("node:fs/promises")
  ).readFile(`${join(root, "keys", "dev.pem")}.pub`, "utf8");
  await installSolutionPackage(packed.tgzPath, {
    mode: "development",
    trustedPublicKeyPem,
  });
}

describe("solution export/import", () => {
  it("exports the active version as a verifiable tgz and imports it into a fresh store", async () => {
    await installSigned("1.0.0");
    await activateSolution("weflow.demo", "1.0.0");

    const backupPath = join(root, "backup.tgz");
    const exported = await exportSolutionBackup("weflow.demo", backupPath);
    expect(exported.version).toBe("1.0.0");
    expect(exported.solutionId).toBe("weflow.demo");

    // Wipe the store, then restore from the backup.
    const storeRoot = process.env.WEFLOW_SOLUTION_STORE;
    if (!storeRoot) throw new Error("store env missing");
    await rm(storeRoot, { recursive: true, force: true });
    const imported = await importSolutionBackup(backupPath, {
      mode: "development",
      trustedPublicKeyPem: await (
        await import("node:fs/promises")
      ).readFile(`${join(root, "keys", "dev.pem")}.pub`, "utf8"),
    });
    expect(imported).toMatchObject({
      solutionId: "weflow.demo",
      version: "1.0.0",
    });
    await expect(listInstalledVersions("weflow.demo")).resolves.toEqual([
      "1.0.0",
    ]);
  });

  it("refuses to overwrite a different installed version without force", async () => {
    await installSigned("1.0.0");
    await activateSolution("weflow.demo", "1.0.0");
    const backupPath = join(root, "backup.tgz");
    await exportSolutionBackup("weflow.demo", backupPath);

    // Install a different version so the active state diverges.
    await installSigned("2.0.0");
    await activateSolution("weflow.demo", "2.0.0");

    await expect(
      importSolutionBackup(backupPath, {
        mode: "development",
        trustedPublicKeyPem: await (
          await import("node:fs/promises")
        ).readFile(`${join(root, "keys", "dev.pem")}.pub`, "utf8"),
      }),
    ).rejects.toThrow("solution_import_conflict:weflow.demo:2.0.0");

    const forced = await importSolutionBackup(backupPath, {
      mode: "development",
      trustedPublicKeyPem: await (
        await import("node:fs/promises")
      ).readFile(`${join(root, "keys", "dev.pem")}.pub`, "utf8"),
      force: true,
    });
    expect(forced).toMatchObject({ version: "1.0.0" });
    await expect(readActiveVersion("weflow.demo")).resolves.toBe("1.0.0");
  });
});

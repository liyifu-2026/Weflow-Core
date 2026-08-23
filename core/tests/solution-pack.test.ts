import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeStagedSolution,
  describeStagedSolutionPackage,
  extractSolutionTgz,
  generateSigningKey,
  installSolutionPackage,
  packSolution,
  signSolutionPackage,
  writeSolutionLock,
} from "../infrastructure/solutions/solution-pack.js";
import { stagePackagedSolution } from "../infrastructure/solutions/solution-stage.js";
import {
  describeSolution,
  parseSolutionLock,
  verifySolutionSignature,
} from "@weflow/solution-sdk";

let root: string;
let previousStore: string | undefined;

function storeRoot(): string {
  const value = process.env.WEFLOW_SOLUTION_STORE;
  if (!value) throw new Error("WEFLOW_SOLUTION_STORE not set");
  return value;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weflow-pack-"));
  previousStore = process.env.WEFLOW_SOLUTION_STORE;
  process.env.WEFLOW_SOLUTION_STORE = join(root, "store");
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.WEFLOW_SOLUTION_STORE;
  else process.env.WEFLOW_SOLUTION_STORE = previousStore;
  await rm(root, { recursive: true, force: true });
});

const MINIMAL_MANIFEST = {
  apiVersion: "weflow.io/v1",
  kind: "Solution",
  metadata: {
    id: "weflow.demo",
    name: "Demo Solution",
    version: "1.0.0",
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

async function writeDemoSolution(source: string): Promise<void> {
  await mkdir(join(source, "plugins", "demo", "src"), { recursive: true });
  await writeFile(
    join(source, "solution.manifest.json"),
    JSON.stringify(MINIMAL_MANIFEST, null, 2),
  );
  await writeFile(
    join(source, "plugins", "demo", "src", "helper.ts"),
    'export const helperMarker = "inlined-helper-marker";\n',
  );
  await writeFile(
    join(source, "plugins", "demo", "src", "plugin.ts"),
    'import { helperMarker } from "./helper.js";\n' +
      'export const plugin = { manifest: { id: "demo-plugin", version: "1.0.0", sdkVersion: "1.0.0", provides: [], requires: [], permissions: [] }, marker: helperMarker };\n',
  );
}

describe("solution pack", () => {
  it("stages a solution and bundles plugins into self-contained dist files", async () => {
    const source = join(root, "source");
    await writeDemoSolution(source);

    const staged = await stagePackagedSolution(source);
    const bundle = await readFile(
      join(staged, "plugins", "demo", "dist", "plugin.js"),
      "utf8",
    );
    expect(bundle).toContain("inlined-helper-marker");
    expect(bundle).not.toMatch(/from\s+"\./);
  });

  it("builds a lock whose resolved artifacts cover every manifest artifact", async () => {
    const source = join(root, "source");
    await writeDemoSolution(source);
    const staged = await stagePackagedSolution(source);

    const lock = await writeSolutionLock(staged, MINIMAL_MANIFEST);
    const parsed = parseSolutionLock(lock);
    const resolved = parsed.resolvedArtifacts.find(
      (item) => item.id === "demo-plugin",
    );
    expect(resolved).toMatchObject({
      id: "demo-plugin",
      ref: "file:./plugins/demo",
    });
    if (!resolved) throw new Error("demo-plugin artifact missing from lock");
    expect(resolved.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(resolved.size).toBeGreaterThan(0);
    expect(parsed.resolvedArtifacts).toHaveLength(1);
    expect(parsed.manifestDigest).toBe(
      describeSolution(MINIMAL_MANIFEST).manifestDigest,
    );
  });

  it("signs a package and verifies with the matching public key", async () => {
    const source = join(root, "source");
    await writeDemoSolution(source);
    const staged = await stagePackagedSolution(source);
    const { keyPair } = await generateSigningKey(
      join(root, "keys", "test.pem"),
    );
    await writeSolutionLock(staged, MINIMAL_MANIFEST);
    const stagedDescriptor = await describeStagedSolution(staged);
    const signature = signSolutionPackage(
      stagedDescriptor,
      keyPair.privateKeyPem,
      "weflow-test",
    );
    expect(
      verifySolutionSignature(
        stagedDescriptor,
        signature,
        keyPair.publicKeyPem,
      ),
    ).toBe(true);
    expect(
      verifySolutionSignature(
        stagedDescriptor,
        signature,
        (await generateSigningKey(join(root, "keys", "other.pem"))).keyPair
          .publicKeyPem,
      ),
    ).toBe(false);
  });

  it("packs a tgz that verifies as a complete package after extraction", async () => {
    const source = join(root, "source");
    await writeDemoSolution(source);
    const outDir = join(root, "out");

    const result = await packSolution({
      sourceDir: source,
      outDir,
      privateKeyPemPath: join(root, "keys", "dev.pem"),
      keyId: "weflow-test",
    });

    expect(result.tgzPath).toMatch(/weflow\.demo-1\.0\.0\.tgz$/);
    const extracted = await extractSolutionTgz(
      result.tgzPath,
      join(root, "extracted"),
    );
    const descriptor = await describeStagedSolutionPackage(extracted);
    expect(descriptor.manifest.metadata.id).toBe("weflow.demo");
    expect(descriptor.signature.keyId).toBe("weflow-test");
    // The extracted package is self-contained: bundled plugin code inlined.
    const bundle = await readFile(
      join(extracted, "plugins", "demo", "dist", "plugin.js"),
      "utf8",
    );
    expect(bundle).toContain("inlined-helper-marker");
  });

  it("installs a packed tgz into the store and activates it", async () => {
    const source = join(root, "source");
    await writeDemoSolution(source);
    const outDir = join(root, "out");
    const devKeyPath = join(root, "keys", "dev.pem");
    const packed = await packSolution({
      sourceDir: source,
      outDir,
      privateKeyPemPath: devKeyPath,
      keyId: "weflow-test",
    });
    const trustedPublicKeyPem = await readFile(`${devKeyPath}.pub`, "utf8");

    const installed = await installSolutionPackage(packed.tgzPath, {
      mode: "development",
      trustedPublicKeyPem,
    });
    expect(installed).toMatchObject({
      solutionId: "weflow.demo",
      version: "1.0.0",
    });
    expect(await readdir(join(storeRoot(), "weflow.demo"))).toContain("1.0.0");
  });

  it("installs a packed tgz without re-bundling the extracted package", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const source = join(root, "source-ext");
    // Plugin source imports a bare specifier that only resolves inside the
    // source workspace's node_modules; the tgz must carry the bundled dist.
    const sdkDir = join(source, "node_modules", "@test", "sdk");
    await mkdir(sdkDir, { recursive: true });
    await writeFile(
      join(sdkDir, "package.json"),
      JSON.stringify({ name: "@test/sdk", version: "1.0.0", main: "index.js" }),
    );
    await writeFile(
      join(sdkDir, "index.js"),
      "export const sdkMarker = 'sdk';",
    );
    await mkdir(join(source, "plugins", "demo", "src"), { recursive: true });
    await writeFile(
      join(source, "solution.manifest.json"),
      JSON.stringify(MINIMAL_MANIFEST),
    );
    await writeFile(
      join(source, "plugins", "demo", "src", "plugin.ts"),
      'import { sdkMarker } from "@test/sdk";\n' +
        'export const plugin = { manifest: { id: "demo-plugin", version: "1.0.0", sdkVersion: "1.0.0", provides: [], requires: [], permissions: [] }, marker: sdkMarker };\n',
    );
    const outDir = join(root, "out-ext");
    const devKeyPath = join(root, "keys", "ext.pem");
    const packed = await packSolution({
      sourceDir: source,
      outDir,
      privateKeyPemPath: devKeyPath,
      keyId: "weflow-test",
    });
    const trustedPublicKeyPem = await readFile(`${devKeyPath}.pub`, "utf8");

    // The extracted package has no node_modules; installing must not try to
    // resolve "@test/sdk" again. Success proves no re-bundling happened.
    const installed = await installSolutionPackage(packed.tgzPath, {
      mode: "development",
      trustedPublicKeyPem,
    });
    expect(installed.solutionId).toBe("weflow.demo");
    const bundle = await readFile(
      join(
        storeRoot(),
        "weflow.demo",
        "1.0.0",
        "plugins",
        "demo",
        "dist",
        "plugin.js",
      ),
      "utf8",
    );
    expect(bundle).toContain("sdkMarker");
  });

  it("refuses production install without a trusted public key", async () => {
    const source = join(root, "source");
    await writeDemoSolution(source);
    const outDir = join(root, "out");
    const packed = await packSolution({
      sourceDir: source,
      outDir,
      privateKeyPemPath: join(root, "keys", "dev.pem"),
      keyId: "weflow-test",
    });

    await expect(
      installSolutionPackage(packed.tgzPath, { mode: "production" }),
    ).rejects.toThrow("trusted_public_key_required");
  });
});

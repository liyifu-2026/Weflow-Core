import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  putRegistryPackage,
  readRegistryEntry,
  readRegistryIndex,
} from "../infrastructure/solutions/solution-registry.js";
import { registerSolutionRegistryRoutes } from "../infrastructure/solutions/solution-registry-routes.js";
import {
  defaultDevSigningKeyPath,
  packSolution,
} from "../infrastructure/solutions/solution-pack.js";

let root: string;
let previousStore: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weflow-registry-"));
  previousStore = process.env.WEFLOW_SOLUTION_STORE;
  process.env.WEFLOW_SOLUTION_STORE = join(root, "store");
});

afterEach(async () => {
  if (previousStore === undefined) delete process.env.WEFLOW_SOLUTION_STORE;
  else process.env.WEFLOW_SOLUTION_STORE = previousStore;
  await rm(root, { recursive: true, force: true });
});

function demoManifest(version: string, solutionId = "weflow.demo"): unknown {
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

async function writeAndPack(version: string): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const source = join(root, `source-${version}`);
  await mkdir(join(source, "plugins", "demo", "dist"), { recursive: true });
  await writeFile(
    join(source, "solution.manifest.json"),
    JSON.stringify(demoManifest(version)),
  );
  await writeFile(
    join(source, "plugins", "demo", "dist", "plugin.js"),
    `export const bundledVersion = ${JSON.stringify(version)};\nexport const plugin = {};\n`,
  );
  // Pack with the default development signing key so the registry's default
  // trust anchor (dev-signing-key.pem.pub) matches the real publish flow.
  const packed = await packSolution({
    sourceDir: source,
    outDir: join(root, "dist"),
    privateKeyPemPath: defaultDevSigningKeyPath(),
    keyId: "weflow-test",
  });
  return packed.tgzPath;
}

describe("solution registry storage", () => {
  it("stores a package and exposes it through the index and entry views", async () => {
    const registryRoot = join(root, "registry");
    const tgzPath = await writeAndPack("1.0.0");

    const entry = await putRegistryPackage({
      root: registryRoot,
      expectedSolutionId: "weflow.demo",
      expectedVersion: "1.0.0",
      tgzSource: tgzPath,
    });
    expect(entry).toMatchObject({
      version: "1.0.0",
      solutionId: "weflow.demo",
    });
    expect(entry.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const index = await readRegistryIndex(registryRoot, "weflow.demo");
    expect(index?.versions.map((item) => item.version)).toEqual(["1.0.0"]);

    const single = await readRegistryEntry(
      registryRoot,
      "weflow.demo",
      "1.0.0",
    );
    expect(single?.version).toBe("1.0.0");
    expect(
      await readRegistryEntry(registryRoot, "weflow.demo", "9.9.9"),
    ).toBeNull();
    expect(await readRegistryIndex(registryRoot, "weflow.missing")).toBeNull();
  });

  it("keeps multiple versions sorted in the index and rejects version mismatch", async () => {
    const registryRoot = join(root, "registry");
    const tgz1 = await writeAndPack("1.0.0");
    await putRegistryPackage({
      root: registryRoot,
      expectedVersion: "1.0.0",
      tgzSource: tgz1,
    });
    const tgz2 = await writeAndPack("1.1.0");
    await putRegistryPackage({
      root: registryRoot,
      expectedVersion: "1.1.0",
      tgzSource: tgz2,
    });

    // Publishing package contents under a mismatched version must fail.
    await expect(
      putRegistryPackage({
        root: registryRoot,
        expectedSolutionId: "weflow.demo",
        expectedVersion: "3.0.0",
        tgzSource: tgz2,
      }),
    ).rejects.toThrow("solution_registry_version_mismatch");

    const index = await readRegistryIndex(registryRoot, "weflow.demo");
    expect(index?.versions.map((item) => item.version)).toEqual([
      "1.0.0",
      "1.1.0",
    ]);
  });
});

describe("solution registry http endpoints", () => {
  async function buildApp(options?: {
    publishToken?: string;
    readToken?: string;
  }) {
    const app = Fastify({ logger: false });
    registerSolutionRegistryRoutes(app, {
      root: join(root, "registry-http"),
      publishToken: options?.publishToken,
      readToken: options?.readToken,
    });
    await app.ready();
    return app;
  }

  it("serves index, entry metadata and the tarball", async () => {
    const registryRoot = join(root, "registry-http");
    const tgzPath = await writeAndPack("1.0.0");
    await putRegistryPackage({
      root: registryRoot,
      expectedVersion: "1.0.0",
      tgzSource: tgzPath,
    });
    const app = await buildApp();

    const indexResponse = await app.inject({
      method: "GET",
      url: "/v1/solutions/weflow.demo",
    });
    expect(indexResponse.statusCode).toBe(200);
    expect(indexResponse.json()).toMatchObject({ solutionId: "weflow.demo" });

    const entryResponse = await app.inject({
      method: "GET",
      url: "/v1/solutions/weflow.demo/1.0.0",
    });
    expect(entryResponse.statusCode).toBe(200);
    expect(entryResponse.json<{ version: string }>().version).toBe("1.0.0");

    const tarballResponse = await app.inject({
      method: "GET",
      url: "/v1/solutions/weflow.demo/1.0.0.tgz",
    });
    expect(tarballResponse.statusCode).toBe(200);
    expect(tarballResponse.headers["content-type"]).toContain("gzip");

    const missing = await app.inject({
      method: "GET",
      url: "/v1/solutions/weflow.demo/2.0.0.tgz",
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("lists all registered solutions with version counts", async () => {
    const app = await buildApp({ publishToken: "t" });
    const tgzA = await writeAndPack("1.0.0");
    await putRegistryPackage({
      root: join(root, "registry-http"),
      expectedVersion: "1.0.0",
      tgzSource: tgzA,
    });
    // A second solution under a different id.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const sourceB = join(root, "source-b");
    await mkdir(join(sourceB, "plugins", "demo", "dist"), { recursive: true });
    await writeFile(
      join(sourceB, "solution.manifest.json"),
      JSON.stringify(demoManifest("1.0.0", "weflow.other")),
    );
    await writeFile(
      join(sourceB, "plugins", "demo", "dist", "plugin.js"),
      "export const plugin = {};",
    );
    const packedB = await packSolution({
      sourceDir: sourceB,
      outDir: join(root, "dist-b"),
      privateKeyPemPath: defaultDevSigningKeyPath(),
      keyId: "weflow-test",
    });
    await putRegistryPackage({
      root: join(root, "registry-http"),
      expectedVersion: "1.0.0",
      tgzSource: packedB.tgzPath,
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/v1/solutions",
    });
    expect(listResponse.statusCode).toBe(200);
    const body = listResponse.json<{
      solutions: Array<{ solutionId: string; versionCount: number }>;
    }>();
    const ids = body.solutions.map((item) => item.solutionId).sort();
    expect(ids).toEqual(["weflow.demo", "weflow.other"]);
    expect(body.solutions.every((item) => item.versionCount >= 1)).toBe(true);
    await app.close();
    void tgzA;
    void packedB;
  });

  it("requires a bearer token for read when configured", async () => {
    const app = await buildApp({ readToken: "read-secret" });
    const tgzPath = await writeAndPack("1.0.0");
    await putRegistryPackage({
      root: join(root, "registry-http"),
      expectedVersion: "1.0.0",
      tgzSource: tgzPath,
    });

    const denied = await app.inject({
      method: "GET",
      url: "/v1/solutions/weflow.demo",
    });
    expect(denied.statusCode).toBe(401);

    const wrongToken = await app.inject({
      method: "GET",
      url: "/v1/solutions/weflow.demo",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrongToken.statusCode).toBe(401);

    const ok = await app.inject({
      method: "GET",
      url: "/v1/solutions/weflow.demo",
      headers: { authorization: "Bearer read-secret" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ solutionId: string }>().solutionId).toBe("weflow.demo");
    await app.close();
  });

  it("requires a bearer token for publish when configured", async () => {
    const app = await buildApp({ publishToken: "secret-token" });
    const tgzPath = await writeAndPack("1.0.0");
    const body = await import("node:fs/promises").then((fs) =>
      fs.readFile(tgzPath),
    );

    const denied = await app.inject({
      method: "PUT",
      url: "/v1/solutions/weflow.demo/1.0.0",
      headers: { "content-type": "application/octet-stream" },
      payload: body,
    });
    expect(denied.statusCode).toBe(401);

    const wrongToken = await app.inject({
      method: "PUT",
      url: "/v1/solutions/weflow.demo/1.0.0",
      headers: {
        "content-type": "application/octet-stream",
        authorization: "Bearer nope",
      },
      payload: body,
    });
    expect(wrongToken.statusCode).toBe(401);

    const ok = await app.inject({
      method: "PUT",
      url: "/v1/solutions/weflow.demo/1.0.0",
      headers: {
        "content-type": "application/octet-stream",
        authorization: "Bearer secret-token",
      },
      payload: body,
    });
    expect(ok.statusCode).toBe(201);
    const index = await readRegistryIndex(
      join(root, "registry-http"),
      "weflow.demo",
    );
    expect(index?.versions).toHaveLength(1);
    await app.close();
  });

  it("verifies the package signature before accepting a publish", async () => {
    const app = await buildApp({ publishToken: "secret-token" });
    const tgzPath = await writeAndPack("1.0.0");
    const body = await import("node:fs/promises").then((fs) =>
      fs.readFile(tgzPath),
    );
    // Replace the machine-level trust anchor so the packaged signature no
    // longer verifies against the registry's default development trust.
    const { writeFile } = await import("node:fs/promises");
    const { defaultDevSigningKeyPath, generateSigningKey } =
      await import("../infrastructure/solutions/solution-pack.js");
    const anchorPub = `${defaultDevSigningKeyPath()}.pub`;
    const originalAnchorPub = await readFile(anchorPub, "utf8");
    const evilKey = await generateSigningKey(join(root, "keys", "evil.pem"));
    await writeFile(anchorPub, evilKey.keyPair.publicKeyPem);

    const response = await app.inject({
      method: "PUT",
      url: "/v1/solutions/weflow.demo/1.0.0",
      headers: {
        "content-type": "application/octet-stream",
        authorization: "Bearer secret-token",
      },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("signature");
    // Restore the machine-level trust anchor for other tests on this host.
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(anchorPub, originalAnchorPub),
    );
    await app.close();
  });
});

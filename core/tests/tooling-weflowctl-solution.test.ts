import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runSolutionCommand,
  type CommandResult,
} from "../../tooling/weflowctl/src/weflowctl-solution.js";

function expectOk(result: CommandResult): Record<string, unknown> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

let root: string;
let previousStore: string | undefined;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weflow-cli-"));
  previousStore = process.env.WEFLOW_SOLUTION_STORE;
  previousHome = process.env.WEFLOW_HOME;
  process.env.WEFLOW_SOLUTION_STORE = join(root, "store");
  process.env.WEFLOW_HOME = join(root, "home");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (previousStore === undefined) delete process.env.WEFLOW_SOLUTION_STORE;
  else process.env.WEFLOW_SOLUTION_STORE = previousStore;
  if (previousHome === undefined) delete process.env.WEFLOW_HOME;
  else process.env.WEFLOW_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

function demoManifest(version: string): string {
  return JSON.stringify({
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
  });
}

async function writeSource(version: string): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const source = join(root, `source-${version}`);
  await mkdir(join(source, "plugins", "demo", "dist"), { recursive: true });
  await writeFile(
    join(source, "solution.manifest.json"),
    demoManifest(version),
  );
  await writeFile(
    join(source, "plugins", "demo", "dist", "plugin.js"),
    `export const bundledVersion = ${JSON.stringify(version)};\nexport const plugin = {};\n`,
  );
  return source;
}

describe("weflowctl solution commands", () => {
  it("runs publish 锟?install 锟?activate 锟?update 锟?rollback end to end", async () => {
    const outDir = join(root, "dist");

    // Publish 1.0.0
    const source1 = await writeSource("1.0.0");
    const published = expectOk(
      await runSolutionCommand(["publish", source1, "--out", outDir]),
    );
    expect(published.tgzPath).toMatch(/weflow\.demo-1\.0\.0\.tgz$/);

    // Install + activate
    const installed = expectOk(
      await runSolutionCommand(["install", String(published.tgzPath)]),
    );
    expect(installed.version).toBe("1.0.0");
    const activated = expectOk(
      await runSolutionCommand(["activate", "weflow.demo"]),
    );
    expect(activated.activeVersion).toBe("1.0.0");

    // Publish + install 1.1.0, then update within minor strategy
    const source2 = await writeSource("1.1.0");
    const published2 = expectOk(
      await runSolutionCommand(["publish", source2, "--out", outDir]),
    );
    await runSolutionCommand(["install", String(published2.tgzPath)]);
    const updated = expectOk(
      await runSolutionCommand([
        "update",
        "weflow.demo",
        "--strategy",
        "minor",
      ]),
    );
    expect(updated.status).toBe("updated");
    expect(updated.to).toBe("1.1.0");

    // Rollback restores 1.0.0
    const rolledBack = expectOk(
      await runSolutionCommand(["rollback", "weflow.demo"]),
    );
    expect(rolledBack).toMatchObject({ from: "1.1.0", to: "1.0.0" });

    // List reflects final state
    const listed = expectOk(await runSolutionCommand(["list", "weflow.demo"]));
    expect(listed.activeVersion).toBe("1.0.0");
    expect(listed.installedVersions).toEqual(["1.0.0", "1.1.0"]);
  });

  it("manages keys: keygen/list/import/export", async () => {
    const generated = expectOk(await runSolutionCommand(["keygen"]));
    expect(String(generated.privateKeyPath)).toContain(join(root, "home"));

    const listed = expectOk(await runSolutionCommand(["key", "list"]));
    const keys = listed.keys as Array<{ name: string; fingerprint: string }>;
    expect(keys.map((item) => item.name)).toContain("dev-signing-key");

    // Import a foreign key.
    const { mkdir } = await import("node:fs/promises");
    const foreign = join(root, "foreign.pem");
    const { generateSigningKey } =
      await import("../infrastructure/solutions/solution-pack.js");
    await mkdir(root, { recursive: true });
    const foreignPair = await generateSigningKey(foreign);
    const imported = expectOk(
      await runSolutionCommand([
        "key",
        "import",
        "--key-file",
        foreign,
        "--name",
        "release",
      ]),
    );
    expect(imported.publicKeyPem).toBe(foreignPair.keyPair.publicKeyPem);

    const exported = expectOk(
      await runSolutionCommand(["key", "export", "--key", foreign]),
    );
    expect(exported.publicKeyPem).toBe(foreignPair.keyPair.publicKeyPem);

    const relisted = expectOk(await runSolutionCommand(["key", "list"]));
    expect(
      (relisted.keys as Array<{ name: string }>).map((item) => item.name),
    ).toContain("release");
  });

  it("stores registry credentials and masks tokens in status", async () => {
    const loggedIn = expectOk(
      await runSolutionCommand([
        "registry",
        "login",
        "--url",
        "http://reg.test",
        "--token",
        "super-secret-token",
      ]),
    );
    expect(loggedIn.url).toBe("http://reg.test");

    const status = expectOk(await runSolutionCommand(["registry", "status"]));
    expect(status.loggedIn).toBe(true);
    expect(String(status.token)).toContain("*");
    expect(String(status.token)).not.toContain("super-secret");

    const loggedOut = expectOk(
      await runSolutionCommand(["registry", "logout"]),
    );
    expect(loggedOut.loggedIn).toBe(false);
    const after = expectOk(await runSolutionCommand(["registry", "status"]));
    expect(after.loggedIn).toBe(false);
  });

  it("publish uses the stored login token automatically", async () => {
    const outDir = join(root, "dist");
    const source = await writeSource("1.0.0");
    await runSolutionCommand([
      "registry",
      "login",
      "--url",
      "http://reg.test",
      "--token",
      "stored-token",
    ]);
    const putAuths: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (init?.method === "PUT") {
          putAuths.push(
            new Headers(init.headers).get("authorization") ?? undefined,
          );
          return Promise.resolve(Response.json({ version: "1.0.0" }));
        }
        return Promise.resolve(Response.json({ versions: [] }));
      }),
    );
    expectOk(
      await runSolutionCommand([
        "publish",
        source,
        "--out",
        outDir,
        "--registry",
        "http://reg.test",
      ]),
    );
    expect(putAuths[0]).toBe("Bearer stored-token");
  });

  it("shows info, versions and history for an installed solution", async () => {
    const outDir = join(root, "dist");
    for (const version of ["1.0.0", "1.1.0"]) {
      const source = await writeSource(version);
      const packed = expectOk(
        await runSolutionCommand(["publish", source, "--out", outDir]),
      );
      if (version === "1.0.0") {
        await runSolutionCommand(["install", String(packed.tgzPath)]);
        await runSolutionCommand(["activate", "weflow.demo"]);
      } else {
        await runSolutionCommand(["install", String(packed.tgzPath)]);
        await runSolutionCommand([
          "update",
          "weflow.demo",
          "--strategy",
          "minor",
        ]);
      }
    }

    const info = expectOk(await runSolutionCommand(["info", "weflow.demo"]));
    expect(info.activeVersion).toBe("1.1.0");
    expect(info.health).toMatchObject({ ok: true });
    expect((info.manifest as Record<string, unknown>).name).toBe("Demo");

    const versions = expectOk(
      await runSolutionCommand(["versions", "weflow.demo"]),
    );
    expect(versions.installed).toEqual(["1.0.0", "1.1.0"]);

    const history = expectOk(
      await runSolutionCommand(["history", "weflow.demo"]),
    );
    const entries = history.history as Array<{ version: string }>;
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("rolls back to an explicit version with rollback --to", async () => {
    const outDir = join(root, "dist-rb");
    for (const version of ["1.0.0", "1.1.0"]) {
      const source = await writeSource(version);
      const packed = expectOk(
        await runSolutionCommand(["publish", source, "--out", outDir]),
      );
      await runSolutionCommand(["install", String(packed.tgzPath)]);
    }
    await runSolutionCommand(["activate", "weflow.demo", "1.1.0"]);

    const rolledBack = expectOk(
      await runSolutionCommand(["rollback", "weflow.demo", "--to", "1.0.0"]),
    );
    expect(rolledBack).toMatchObject({ from: "1.1.0", to: "1.0.0" });
  });

  it("disables and uninstalls with confirmation semantics", async () => {
    const outDir = join(root, "dist-du");
    const source = await writeSource("1.0.0");
    const packed = expectOk(
      await runSolutionCommand(["publish", source, "--out", outDir]),
    );
    await runSolutionCommand(["install", String(packed.tgzPath)]);
    await runSolutionCommand(["activate", "weflow.demo"]);

    // Uninstall without --yes must fail closed.
    const refused = await runSolutionCommand(["uninstall", "weflow.demo"]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("uninstall_confirm_required");
      expect(refused.hint).toContain("--yes");
    }

    const disabled = expectOk(
      await runSolutionCommand(["disable", "weflow.demo"]),
    );
    expect(disabled.disabled).toBe(true);
    const info = expectOk(await runSolutionCommand(["info", "weflow.demo"]));
    expect(info.activeVersion).toBeNull();

    const uninstalled = expectOk(
      await runSolutionCommand(["uninstall", "weflow.demo", "--yes"]),
    );
    expect(uninstalled.removedVersions).toEqual(["1.0.0"]);
    const listed = expectOk(
      await runSolutionCommand(["versions", "weflow.demo"]),
    );
    expect(listed.installed).toEqual([]);
  });

  it("prunes old versions keeping the active one", async () => {
    const outDir = join(root, "dist-prune");
    for (const version of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
      const source = await writeSource(version);
      const packed = expectOk(
        await runSolutionCommand(["publish", source, "--out", outDir]),
      );
      await runSolutionCommand(["install", String(packed.tgzPath)]);
    }
    await runSolutionCommand(["activate", "weflow.demo", "1.0.0"]);

    const pruned = expectOk(
      await runSolutionCommand(["prune", "weflow.demo", "--keep", "2"]),
    );
    expect(pruned.removed).toEqual(["1.1.0"]);
    const versions = expectOk(
      await runSolutionCommand(["versions", "weflow.demo"]),
    );
    expect(versions.installed).toEqual(["1.0.0", "1.2.0", "1.3.0"]);
  });

  it("update refuses unknown strategies and reports failure", async () => {
    await writeSource("1.0.0");
    const result = await runSolutionCommand([
      "update",
      "weflow.missing",
      "--strategy",
      "sometimes",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid_update_strategy");
  });

  it("install fails closed for a tampered package", async () => {
    const outDir = join(root, "dist");
    const source = await writeSource("1.0.0");
    await runSolutionCommand(["publish", source, "--out", outDir]);
    const tgzPath = join(outDir, "weflow.demo-1.0.0.tgz");
    // Overwrite the machine-level trust anchor with an unrelated key.
    const { writeFile } = await import("node:fs/promises");
    const { defaultDevSigningKeyPath, generateSigningKey } =
      await import("../infrastructure/solutions/solution-pack.js");
    const anchorPub = `${defaultDevSigningKeyPath()}.pub`;
    const originalAnchorPub = await readFile(anchorPub, "utf8");
    const attackerKey = await generateSigningKey(
      join(root, "keys", "attacker.pem"),
    );
    await writeFile(anchorPub, attackerKey.keyPair.publicKeyPem);

    try {
      const result = await runSolutionCommand(["install", tgzPath]);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toContain("solution_signature_invalid");
    } finally {
      await writeFile(anchorPub, originalAnchorPub);
    }
  });

  it("publish pushes the tarball when --registry is given", async () => {
    const outDir = join(root, "dist");
    const source = await writeSource("1.0.0");
    const putCalls: Array<{ url: string; auth: string | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (init?.method === "PUT") {
            putCalls.push({
              url,
              auth: (init.headers as Record<string, string> | undefined)
                ?.authorization,
            });
            return Promise.resolve(
              Response.json({ version: "1.0.0", solutionId: "weflow.demo" }),
            );
          }
          return Promise.resolve(Response.json({ versions: [] }));
        },
      ),
    );

    const data = expectOk(
      await runSolutionCommand([
        "publish",
        source,
        "--out",
        outDir,
        "--registry",
        "http://reg.test",
        "--registry-token",
        "tok-1",
      ]),
    );

    expect(data.registry).toMatchObject({ version: "1.0.0" });
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.url).toBe(
      "http://reg.test/v1/solutions/weflow.demo/1.0.0",
    );
    expect(putCalls[0]?.auth).toBe("Bearer tok-1");
  });

  it("install resolves a bare solution id from the registry", async () => {
    const outDir = join(root, "dist");
    const source = await writeSource("1.2.0");
    const published = expectOk(
      await runSolutionCommand(["publish", source, "--out", outDir]),
    );
    const tgzBytes = await readFile(String(published.tgzPath));

    vi.stubGlobal(
      "fetch",
      vi.fn((input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.endsWith("/v1/solutions/weflow.demo")) {
          return Promise.resolve(
            Response.json({
              solutionId: "weflow.demo",
              versions: [{ version: "1.2.0", size: tgzBytes.byteLength }],
            }),
          );
        }
        if (url.endsWith("/v1/solutions/weflow.demo/1.2.0.tgz")) {
          return Promise.resolve(
            new Response(new Uint8Array(tgzBytes), {
              status: 200,
              headers: { "content-type": "application/gzip" },
            }),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      }),
    );

    const installed = expectOk(
      await runSolutionCommand([
        "install",
        "weflow.demo",
        "--registry",
        "http://reg.test",
        "--version",
        "1.2.0",
      ]),
    );
    expect(installed).toMatchObject({
      solutionId: "weflow.demo",
      version: "1.2.0",
    });
  });

  it("update merges registry candidates and installs the target", async () => {
    const outDir = join(root, "dist");
    const source1 = await writeSource("1.0.0");
    const packed1 = expectOk(
      await runSolutionCommand(["publish", source1, "--out", outDir]),
    );
    await runSolutionCommand(["install", String(packed1.tgzPath)]);
    await runSolutionCommand(["activate", "weflow.demo"]);

    const source2 = await writeSource("1.1.0");
    const packed2 = expectOk(
      await runSolutionCommand(["publish", source2, "--out", outDir]),
    );
    const tgzBytes = await readFile(String(packed2.tgzPath));

    vi.stubGlobal(
      "fetch",
      vi.fn((input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.endsWith("/v1/solutions/weflow.demo")) {
          return Promise.resolve(
            Response.json({
              solutionId: "weflow.demo",
              versions: [{ version: "1.1.0" }],
            }),
          );
        }
        if (url.endsWith("/v1/solutions/weflow.demo/1.1.0.tgz")) {
          return Promise.resolve(
            new Response(new Uint8Array(tgzBytes), { status: 200 }),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      }),
    );

    const updated = expectOk(
      await runSolutionCommand([
        "update",
        "weflow.demo",
        "--strategy",
        "minor",
        "--registry",
        "http://reg.test",
      ]),
    );
    expect(updated).toMatchObject({ status: "updated", to: "1.1.0" });
    const listed = expectOk(await runSolutionCommand(["list", "weflow.demo"]));
    expect(listed.activeVersion).toBe("1.1.0");
  });

  it("serves subcommand help through the command layer", async () => {
    const publishHelp = expectOk(
      await runSolutionCommand(["publish", "--help"]),
    );
    expect(String(publishHelp.help)).toContain("publish");
    expect(String(publishHelp.help)).toContain("--registry");

    const listHelp = expectOk(await runSolutionCommand(["list", "--help"]));
    expect(String(listHelp.help)).toContain("list");
  });

  it("attaches stable error codes and hints to failures", async () => {
    const badStrategy = await runSolutionCommand([
      "update",
      "weflow.missing",
      "--strategy",
      "sometimes",
    ]);
    expect(badStrategy.ok).toBe(false);
    if (!badStrategy.ok) {
      expect(badStrategy.code).toBe("invalid_update_strategy");
      expect(badStrategy.hint).toBeTruthy();
    }

    const unknown = await runSolutionCommand(["teleport"] as never[]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.code).toBe("unknown_solution_command");
      expect(unknown.hint).toBeTruthy();
    }
  });

  it("runs verify and digest through the command layer", async () => {
    const outDir = join(root, "dist-verify");
    const source = await writeSource("1.0.0");
    const published = expectOk(
      await runSolutionCommand(["publish", source, "--out", outDir]),
    );
    const tgzPath = String(published.tgzPath);
    const extractedDir = join(root, "extracted-verify");
    const { extractSolutionTgz } =
      await import("../infrastructure/solutions/solution-pack.js");
    const packageDir = await extractSolutionTgz(tgzPath, extractedDir);

    const verified = expectOk(
      await runSolutionCommand(["verify", packageDir, "--development"]),
    );
    expect(verified).toMatchObject({
      valid: true,
      solutionId: "weflow.demo",
      version: "1.0.0",
    });

    const digested = expectOk(await runSolutionCommand(["digest", packageDir]));
    expect(String(digested.manifestDigest)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("returns typed results for lifecycle commands", async () => {
    const outDir = join(root, "dist-typed");
    const source = await writeSource("1.0.0");
    const typedPublish = await runSolutionCommand([
      "publish",
      source,
      "--out",
      outDir,
    ]);
    if (!typedPublish.ok || !("tgzPath" in typedPublish.data)) {
      throw new Error("publish must expose tgzPath");
    }
    expect(typeof typedPublish.data.tgzPath).toBe("string");

    await runSolutionCommand(["install", String(typedPublish.data.tgzPath)]);
    const activated = await runSolutionCommand(["activate", "weflow.demo"]);
    if (!activated.ok || !("activeVersion" in activated.data)) {
      throw new Error("activate must expose activeVersion");
    }
    expect(activated.data.activeVersion).toBe("1.0.0");

    const listed = await runSolutionCommand(["list"]);
    if (!listed.ok || !("solutions" in listed.data)) {
      throw new Error("list must expose solutions array");
    }
    const rows = listed.data.solutions as Array<{
      solutionId: string;
      activeVersion: string | null;
    }>;
    const row = rows.find((item) => item.solutionId === "weflow.demo");
    expect(row?.activeVersion).toBe("1.0.0");
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  downloadSolutionTarball,
  fetchRegistryVersions,
  publishSolutionTarball,
  searchRegistry,
} from "../infrastructure/solutions/solution-registry-client.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weflow-registry-client-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function jsonResponse(body: unknown): Response {
  return Response.json(body);
}

describe("solution registry client", () => {
  it("fetches sorted version strings from the registry index", async () => {
    const calls: string[] = [];
    const versions = await fetchRegistryVersions(
      "http://registry.test",
      "weflow.demo",
      {
        fetchImpl: (input) => {
          calls.push(
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
          );
          return Promise.resolve(
            jsonResponse({
              solutionId: "weflow.demo",
              versions: [
                { version: "1.1.0", manifestDigest: "sha256:a", size: 1 },
                { version: "1.0.0", manifestDigest: "sha256:b", size: 1 },
              ],
            }),
          );
        },
      },
    );
    expect(versions).toEqual(["1.0.0", "1.1.0"]);
    expect(calls[0]).toBe("http://registry.test/v1/solutions/weflow.demo");
  });

  it("sends the read token as a bearer header when provided", async () => {
    let authHeader: string | undefined;
    await fetchRegistryVersions("http://registry.test", "weflow.demo", {
      token: "read-secret",
      fetchImpl: (_input, init) => {
        authHeader = init?.headers
          ? (init.headers as Record<string, string>).authorization
          : undefined;
        return Promise.resolve(
          jsonResponse({ solutionId: "weflow.demo", versions: [] }),
        );
      },
    });
    expect(authHeader).toBe("Bearer read-secret");
  });

  it("searches the registry by keyword, case-insensitively", async () => {
    const results = await searchRegistry("http://registry.test", "CUSTOMER", {
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse({
            solutions: [
              { solutionId: "weflow.customer-support", versionCount: 2 },
              { solutionId: "weflow.demo", versionCount: 1 },
            ],
          }),
        ),
    });
    expect(results).toEqual([
      { solutionId: "weflow.customer-support", versionCount: 2 },
    ]);
  });

  it("downloads a tarball into the destination directory", async () => {
    const tarballBytes = new Uint8Array([31, 139, 8, 0, 0]);
    const destDir = join(root, "dl");
    const result = await downloadSolutionTarball(
      "http://registry.test",
      "weflow.demo",
      "1.1.0",
      destDir,
      {
        fetchImpl: () =>
          Promise.resolve(
            new Response(tarballBytes, {
              status: 200,
              headers: { "content-type": "application/gzip" },
            }),
          ),
      },
    );
    expect(result.tgzPath).toContain(destDir);
    expect(result.tgzPath).toMatch(/weflow\.demo-1\.1\.0\.tgz$/);
    const saved = await readFile(result.tgzPath);
    expect([...saved]).toEqual([...tarballBytes]);
  });

  it("propagates registry errors with stable codes", async () => {
    await expect(
      fetchRegistryVersions("http://registry.test", "weflow.missing", {
        fetchImpl: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: "registry_solution_not_found:weflow.missing",
              }),
              { status: 404 },
            ),
          ),
      }),
    ).rejects.toThrow("registry_solution_not_found:weflow.missing");

    await expect(
      downloadSolutionTarball(
        "http://registry.test",
        "weflow.demo",
        "9.9.9",
        root,
        {
          fetchImpl: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  error: "registry_version_not_found:weflow.demo:9.9.9",
                }),
                { status: 404 },
              ),
            ),
        },
      ),
    ).rejects.toThrow("registry_version_not_found:weflow.demo:9.9.9");
  });

  it("publishes a tarball with a bearer token and returns the entry", async () => {
    const tarballPath = join(root, "weflow.demo-1.0.0.tgz");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(tarballPath, Buffer.from([1, 2, 3])),
    );
    let authHeader: string | undefined;
    let url = "";
    const entry = await publishSolutionTarball(
      "http://registry.test",
      tarballPath,
      {
        token: "secret",
        fetchImpl: (input, init) => {
          url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          authHeader =
            new Headers(init?.headers).get("authorization") ?? undefined;
          return Promise.resolve(
            jsonResponse({ version: "1.0.0", publishedAt: "now" }),
          );
        },
      },
    );
    expect(url).toBe("http://registry.test/v1/solutions/weflow.demo/1.0.0");
    expect(entry).toMatchObject({ version: "1.0.0" });
    expect(authHeader).toBe("Bearer secret");
  });

  it("sends the bearer token on publish and rejects without one", async () => {
    const tarballPath = join(root, "weflow.demo-2.0.0.tgz");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(tarballPath, Buffer.from([1])),
    );
    const seen: string[] = [];
    await publishSolutionTarball("http://registry.test", tarballPath, {
      token: "abc",
      fetchImpl: (_input, init) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return Promise.resolve(jsonResponse({ ok: true }));
      },
    });
    expect(seen[0]).toBe("Bearer abc");

    await expect(
      publishSolutionTarball("http://registry.test", tarballPath, {
        fetchImpl: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ error: "registry_publish_disabled" }),
              { status: 403 },
            ),
          ),
      }),
    ).rejects.toThrow("registry_publish_disabled");
  });
});

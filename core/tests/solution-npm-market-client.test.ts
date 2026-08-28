/**
 * Tests for the npm registry client used by the Solution marketplace.
 *
 * Stubs the network via `fetchImpl` so the suite runs offline.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  downloadNpmTarball,
  fetchNpmPackage,
  NPM_DEFAULT_SCOPE,
  searchNpmScope,
} from "../infrastructure/solutions/solution-npm-market-client.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weflow-npm-market-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("npm market client", () => {
  it("searchNpmScope filters by scope and normalises summaries", async () => {
    const calls: string[] = [];
    const packages = await searchNpmScope(NPM_DEFAULT_SCOPE, {
      fetchImpl: (input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        calls.push(url);
        return Promise.resolve(
          Response.json({
            objects: [
              {
                package: {
                  name: "@weflow-leaif/solution-sdk",
                  version: "1.0.0",
                  description: "icon: box\nWeflow Solution SDK",
                  publisher: { username: "weflow" },
                  links: {
                    npm: "https://www.npmjs.com/package/%40weflow-leaif%2Fsolution-sdk",
                  },
                  date: "2026-04-01T12:00:00.000Z",
                },
              },
              {
                package: {
                  name: "@other/scope-leakage",
                  version: "1.0.0",
                  description: "should be filtered out",
                  publisher: { username: "other" },
                },
              },
            ],
            total: 2,
          }),
        );
      },
    });
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      name: "@weflow-leaif/solution-sdk",
      version: "1.0.0",
      publisher: "weflow",
      icon: "box",
      publishedAt: "2026-04-01T12:00:00.000Z",
    });
    expect(packages[0]?.links.npm).toContain("npmjs.com");
    expect(calls[0]).toMatch(/\/-\/v1\/search\?text=scope%3A%40weflow-leaif/);
  });

  it("forwards the bearer token when set", async () => {
    let authHeader: string | undefined;
    await searchNpmScope(NPM_DEFAULT_SCOPE, {
      token: "npm_test_token",
      fetchImpl: (_input, init) => {
        authHeader =
          new Headers(init?.headers).get("authorization") ?? undefined;
        return Promise.resolve(Response.json({ objects: [] }));
      },
    });
    expect(authHeader).toBe("Bearer npm_test_token");
  });

  it("fetchNpmPackage returns versions sorted newest-first", async () => {
    const detail = await fetchNpmPackage("@weflow-leaif/solution-sdk", {
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            name: "@weflow-leaif/solution-sdk",
            description: "Weflow Solution SDK",
            "dist-tags": { latest: "1.2.0" },
            versions: {
              "1.0.0": {
                name: "@weflow-leaif/solution-sdk",
                version: "1.0.0",
                dist: {
                  tarball: "https://reg.test/-/solution-sdk-1.0.0.tgz",
                  integrity: "sha512-a",
                },
              },
              "1.2.0": {
                name: "@weflow-leaif/solution-sdk",
                version: "1.2.0",
                dist: {
                  tarball: "https://reg.test/-/solution-sdk-1.2.0.tgz",
                  integrity: "sha512-b",
                },
              },
              "1.1.0": {
                name: "@weflow-leaif/solution-sdk",
                version: "1.1.0",
                dist: {
                  tarball: "https://reg.test/-/solution-sdk-1.1.0.tgz",
                  integrity: "sha512-c",
                },
              },
            },
          }),
        ),
    });
    expect(detail.distTagLatest).toBe("1.2.0");
    expect(detail.versions.map((item) => item.version)).toEqual([
      "1.2.0",
      "1.1.0",
      "1.0.0",
    ]);
    expect(detail.versions[0]?.integrity).toBe("sha512-b");
  });

  it("downloadNpmTarball fetches the tarball from the npm metadata entry", async () => {
    const tarballBytes = new Uint8Array([31, 139, 8, 0, 0]);
    const result = await downloadNpmTarball(
      "@weflow-leaif/solution-sdk",
      "1.0.0",
      join(root, "dl"),
      {
        fetchImpl: (input) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (url === "https://registry.npmjs.org/@weflow-leaif/solution-sdk") {
            return Promise.resolve(
              Response.json({
                name: "@weflow-leaif/solution-sdk",
                "dist-tags": { latest: "1.0.0" },
                versions: {
                  "1.0.0": {
                    name: "@weflow-leaif/solution-sdk",
                    version: "1.0.0",
                    dist: {
                      tarball: "https://reg.test/solution-sdk-1.0.0.tgz",
                      integrity: "sha512-aaa",
                    },
                  },
                },
              }),
            );
          }
          return Promise.resolve(
            new Response(tarballBytes, {
              status: 200,
              headers: { "content-type": "application/octet-stream" },
            }),
          );
        },
      },
    );
    expect(result.integrity).toBe("sha512-aaa");
    expect(result.bytes).toBe(tarballBytes.byteLength);
    expect(result.tgzPath).toMatch(/@weflow-leaif-solution-sdk-1\.0\.0\.tgz$/);
    const saved = await readFile(result.tgzPath);
    expect([...saved]).toEqual([...tarballBytes]);
  });

  it("surfaces npm_http_error as a stable error code", async () => {
    await expect(
      fetchNpmPackage("@weflow-leaif/missing", {
        fetchImpl: () =>
          Promise.resolve(
            new Response("plain text", {
              status: 404,
              headers: { "content-type": "text/plain" },
            }),
          ),
      }),
    ).rejects.toThrow("npm_http_error:404");
  });
});

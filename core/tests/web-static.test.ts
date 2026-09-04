import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  registerWebStatic,
  resolveWebDistDir,
  shouldFallbackToSpa,
} from "../infrastructure/http/web-static.js";

describe("resolveWebDistDir", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when unset or blank", () => {
    expect(resolveWebDistDir(undefined)).toBeUndefined();
    expect(resolveWebDistDir("   ")).toBeUndefined();
  });

  it("returns undefined when the directory does not exist", () => {
    expect(resolveWebDistDir(join(tmpdir(), `weflow-missing-${Date.now()}`))).toBeUndefined();
  });

  it("returns undefined when index.html is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "weflow-web-"));
    created.push(dir);
    expect(resolveWebDistDir(dir)).toBeUndefined();
  });

  it("resolves a directory containing index.html", () => {
    const dir = mkdtempSync(join(tmpdir(), "weflow-web-"));
    created.push(dir);
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    expect(resolveWebDistDir(dir)).toBe(dir);
  });
});

describe("shouldFallbackToSpa", () => {
  it("falls back for GET navigation on real paths", () => {
    expect(shouldFallbackToSpa("GET", "/conversations")).toBe(true);
    expect(shouldFallbackToSpa("GET", "/settings/ai-employees")).toBe(true);
    expect(shouldFallbackToSpa("GET", "/")).toBe(true);
    expect(shouldFallbackToSpa("GET", "/login?next=%2Fconversations")).toBe(true);
  });

  it("does not fall back for api, health or business plugin prefixes", () => {
    expect(shouldFallbackToSpa("GET", "/api/v1/conversations")).toBe(false);
    expect(shouldFallbackToSpa("GET", "/health/ready")).toBe(false);
    expect(shouldFallbackToSpa("GET", "/customer-support/ai-employees")).toBe(false);
    expect(shouldFallbackToSpa("GET", "/api/v1/auth/login?x=1")).toBe(false);
  });

  it("does not fall back for non-navigation methods", () => {
    expect(shouldFallbackToSpa("POST", "/conversations")).toBe(false);
    expect(shouldFallbackToSpa("PUT", "/settings")).toBe(false);
    expect(shouldFallbackToSpa("DELETE", "/anything")).toBe(false);
  });
});

describe("registerWebStatic", () => {
  let webRoot: string;
  let assetsDir: string;

  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function buildWebRoot(): void {
    webRoot = mkdtempSync(join(tmpdir(), "weflow-webroot-"));
    created.push(webRoot);
    assetsDir = join(webRoot, "assets");
    mkdirSync(assetsDir);
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><html><body>spa</body></html>");
    writeFileSync(join(assetsDir, "app-hash.js"), "console.log(1)");
  }

  it("skips registration when dir is undefined", async () => {
    const server = Fastify({ logger: false });
    expect(await registerWebStatic(server, undefined)).toBe(false);
    await server.close();
  });

  it("serves files, falls back to index.html for SPA paths, 404s reserved prefixes", async () => {
    buildWebRoot();
    const server = Fastify({ logger: false });
    expect(await registerWebStatic(server, webRoot)).toBe(true);

    const file = await server.inject({ method: "GET", url: "/assets/app-hash.js" });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe("console.log(1)");
    expect(file.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const spa = await server.inject({ method: "GET", url: "/conversations" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("spa");

    const reserved = await server.inject({ method: "GET", url: "/api/v1/unknown" });
    expect(reserved.statusCode).toBe(404);
    expect(JSON.parse(reserved.body)).toEqual({ error: "not_found" });

    await server.close();
  });
});

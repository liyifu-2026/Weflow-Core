import { afterEach, describe, expect, it } from "vitest";
import { startHealthServer } from "../infrastructure/health/server.js";

const servers: Awaited<ReturnType<typeof startHealthServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("process health", () => {
  it("reports liveness independently of dependencies", async () => {
    const server = await startHealthServer({
      processName: "agent-worker",
      host: "127.0.0.1",
      port: 0,
      dependencies: [
        {
          name: "postgres",
          check: () => Promise.reject(new Error("offline")),
        },
      ],
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("reports failed readiness dependencies without secrets", async () => {
    const server = await startHealthServer({
      processName: "core-api",
      host: "127.0.0.1",
      port: 0,
      dependencies: [
        {
          name: "redis",
          check: () => Promise.reject(new Error("offline")),
        },
      ],
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      process: "core-api",
      status: "not_ready",
      failed: [{ name: "redis", error: "offline" }],
    });
  });
});

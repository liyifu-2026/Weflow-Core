import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../infrastructure/config/config.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("runtime configuration", () => {
  it("loads required connections and safe defaults", () => {
    process.env.DATABASE_URL =
      "postgresql://weflow:weflow@127.0.0.1:5432/weflow";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";

    const config = loadConfig();

    expect(config.healthHost).toBe("127.0.0.1");
    expect(config.corePort).toBe(3100);
    expect(config.agentWorkerConcurrency).toBe(3);
    expect(config.memoryCaptureConcurrency).toBe(1);
    expect(config.mediaProcessingConcurrency).toBe(1);
    expect(config.databaseUrl).toContain("postgresql://");
  });

  it("loads the optional authenticated Channel Host boundary", () => {
    process.env.DATABASE_URL =
      "postgresql://weflow:weflow@127.0.0.1:5432/weflow";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.CHANNEL_HOST_BASE_URL = "http://127.0.0.1:43123/";
    process.env.CHANNEL_HOST_TOKEN = "test-channel-host";

    expect(loadConfig().channelHost).toEqual({
      baseUrl: "http://127.0.0.1:43123",
      token: "test-channel-host",
      pollIntervalMs: 1000,
    });
  });

  it("rejects an invalid port", () => {
    process.env.DATABASE_URL =
      "postgresql://weflow:weflow@127.0.0.1:5432/weflow";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.CORE_PORT = "70000";

    expect(() => loadConfig()).toThrow();
  });

  it("rejects unsafe Agent Worker concurrency", () => {
    process.env.DATABASE_URL =
      "postgresql://weflow:weflow@127.0.0.1:5432/weflow";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.AGENT_WORKER_CONCURRENCY = "21";

    expect(() => loadConfig()).toThrow();
  });

  it("rejects unsafe Media Processing concurrency", () => {
    process.env.DATABASE_URL =
      "postgresql://weflow:weflow@127.0.0.1:5432/weflow";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.MEDIA_PROCESSING_CONCURRENCY = "21";

    expect(() => loadConfig()).toThrow();
  });

  it("enables only the supported MiMo image model with an independent key", () => {
    process.env.DATABASE_URL =
      "postgresql://weflow:weflow@127.0.0.1:5432/weflow";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.VISION_API_KEY = "temporary-test-key";
    process.env.VISION_MODEL = "mimo-v2.5";

    expect(loadConfig().vision).toMatchObject({
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      name: "mimo-v2.5",
    });
    process.env.VISION_MODEL = "mimo-v2.5-pro";
    expect(() => loadConfig()).toThrow();
  });

  it("loads WeKnora as an optional, separately scoped integration", () => {
    process.env.DATABASE_URL =
      "postgresql://weflow:weflow@127.0.0.1:5432/weflow";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.WEKNORA_API_KEY = "temporary-test-key";
    process.env.WEKNORA_KNOWLEDGE_BASE_IDS = "kb-a, kb-b,kb-a";

    expect(loadConfig().weknora).toMatchObject({
      baseUrl: "http://localhost/api/v1",
      knowledgeBaseIds: ["kb-a", "kb-b"],
    });
  });
});

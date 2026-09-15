/**
 * 知识库连接器配置统一（ADR-0008）单元测试。
 *
 * 覆盖：
 * - resolveWeKnoraClientOptions：界面各认证模式映射、retrieveUrl 剥离、
 *   KB ID 列表解析、字段缺省逐项回落 env、未配置/不支持类型回落 env；
 * - createAdaptiveKnowledgeClient：初始装配走界面配置、快照变化热更新、
 *   未配置时检索抛 weknora_not_configured。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAdaptiveKnowledgeClient,
  parseKnowledgeBaseIdList,
  resolveWeKnoraClientOptions,
  retrieveUrlToBaseUrl,
} from "../infrastructure/knowledge/knowledge-connector-settings.js";
import type { WeKnoraClientOptions } from "../infrastructure/knowledge/weknora-knowledge-client.js";

const envOptions: WeKnoraClientOptions = {
  baseUrl: "https://env.test/api/v1",
  apiKey: "env-key",
  timeoutMs: 15_000,
};

describe("knowledge connector settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips the knowledge-search suffix from retrieveUrl", () => {
    expect(
      retrieveUrlToBaseUrl("http://kb.test/api/v1/knowledge-search"),
    ).toBe("http://kb.test/api/v1");
    expect(retrieveUrlToBaseUrl("http://kb.test/api/v1/")).toBe(
      "http://kb.test/api/v1",
    );
  });

  it("parses comma and whitespace separated knowledge base ids", () => {
    expect(parseKnowledgeBaseIdList("a, b；c\nd")).toEqual(["a", "b", "c", "d"]);
    expect(parseKnowledgeBaseIdList("  ")).toBeUndefined();
    expect(parseKnowledgeBaseIdList(undefined)).toBeUndefined();
  });

  it("falls back to env options when the section is unconfigured", () => {
    expect(resolveWeKnoraClientOptions(undefined, envOptions)).toBe(envOptions);
    expect(resolveWeKnoraClientOptions({}, envOptions)).toBe(envOptions);
    expect(
      resolveWeKnoraClientOptions(
        { type: "weknora", retrieveUrl: "" },
        envOptions,
      ),
    ).toBe(envOptions);
    // custom-rest 暂未接线：按未配置处理。
    expect(
      resolveWeKnoraClientOptions(
        { type: "custom-rest", retrieveUrl: "http://x.test/api/search" },
        envOptions,
      ),
    ).toBe(envOptions);
    expect(resolveWeKnoraClientOptions(undefined, undefined)).toBeUndefined();
  });

  it("maps UI config over env with per-field fallback", () => {
    const options = resolveWeKnoraClientOptions(
      {
        type: "weknora",
        retrieveUrl: "http://ui.test/api/v1/knowledge-search",
        authMode: "header",
        authHeader: "x-api-key",
        authValue: "ui-key",
        knowledgeBaseIds: "kb-1, kb-2",
      },
      envOptions,
    );
    expect(options).toMatchObject({
      baseUrl: "http://ui.test/api/v1",
      authHeaderName: "x-api-key",
      authHeaderValue: "ui-key",
      timeoutMs: 15_000,
      knowledgeBaseIds: ["kb-1", "kb-2"],
    });
    expect(options?.apiKey).toBeUndefined();
  });

  it("maps bearer auth and falls back to env key when authValue is empty", () => {
    const bearer = resolveWeKnoraClientOptions(
      {
        type: "weknora",
        retrieveUrl: "http://ui.test/api/v1/knowledge-search",
        authMode: "bearer",
        authValue: "token-1",
      },
      envOptions,
    );
    expect(bearer).toMatchObject({
      baseUrl: "http://ui.test/api/v1",
      authHeaderName: "Authorization",
      authHeaderValue: "Bearer token-1",
    });

    // 只填端点不填 key：沿用 env 的 x-api-key。
    const authFallback = resolveWeKnoraClientOptions(
      {
        type: "weknora",
        retrieveUrl: "http://ui.test/api/v1/knowledge-search",
      },
      envOptions,
    );
    expect(authFallback).toMatchObject({
      baseUrl: "http://ui.test/api/v1",
      apiKey: "env-key",
    });
  });
});

describe("adaptive knowledge client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts from UI config and hot-reloads on snapshot change", async () => {
    let section: unknown = {
      type: "weknora",
      retrieveUrl: "http://ui.test/api/v1/knowledge-search",
      authMode: "header",
      authHeader: "x-api-key",
      authValue: "ui-key",
    };
    const runtime = await createAdaptiveKnowledgeClient(
      undefined as never,
      envOptions,
      {
        intervalMs: 5,
        readSettings: async () =>
          section === undefined ? undefined : { knowledgeConnector: section },
      },
    );
    expect(runtime.currentOptions()?.baseUrl).toBe("http://ui.test/api/v1");

    // 快照变化 → 轮询后客户端换端点 + 换认证。
    section = {
      type: "weknora",
      retrieveUrl: "http://ui2.test/api/v1/knowledge-search",
      authMode: "bearer",
      authValue: "t2",
    };
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(runtime.currentOptions()).toMatchObject({
      baseUrl: "http://ui2.test/api/v1",
      authHeaderName: "Authorization",
      authHeaderValue: "Bearer t2",
    });
    runtime.stop();
  });

  it("rejects search with weknora_not_configured when nothing is configured", async () => {
    const runtime = await createAdaptiveKnowledgeClient(
      undefined as never,
      undefined,
      {
        intervalMs: 5,
        readSettings: async () => undefined,
      },
    );
    await expect(runtime.client.search("任何问题")).rejects.toThrow(
      "weknora_not_configured",
    );
    runtime.stop();
  });
});

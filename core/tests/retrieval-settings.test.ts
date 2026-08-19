import { describe, expect, it, vi } from "vitest";
import { WeKnoraKnowledgeClient } from "../infrastructure/knowledge/weknora-knowledge-client.js";

/** 上游存储的原始字段（snake_case，含未知字段） */
type StoredSettings = {
  embedding_top_k: number;
  vector_threshold: number;
  keyword_threshold?: number;
  rerank_top_k?: number;
  rerank_threshold?: number;
  rerank_model_id?: string;
  future_upstream_field?: string;
};

function makeClient(handler: (path: string, init: RequestInit) => unknown) {
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const body = handler(url, init);
    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    };
  });
  const client = new WeKnoraKnowledgeClient({
    baseUrl: "http://upstream.test/api/v1",
    apiKey: "test-key",
    timeoutMs: 5_000,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { client, fetch };
}

/** 解析请求体 JSON（BodyInit 为字符串时才合法） */
function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error(`unexpected body type: ${typeof body}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

describe("retrieval-settings client contract", () => {
  it("maps only whitelist fields from upstream", async () => {
    const { client } = makeClient(() => ({
      data: {
        embedding_top_k: 6,
        vector_threshold: 0.5,
        keyword_threshold: 0.4,
        rerank_top_k: 8,
        rerank_threshold: 0.6,
        rerank_model_id: "rerank-a",
        future_upstream_field: "keep-me",
      },
    }));
    const settings = await client.getRetrievalSettings();
    expect(settings).toEqual({
      embeddingTopK: 6,
      vectorThreshold: 0.5,
      keywordThreshold: 0.4,
      rerankTopK: 8,
      rerankThreshold: 0.6,
      rerankModelId: "rerank-a",
    });
  });

  it("read-modify-write preserves unknown upstream fields on update", async () => {
    let stored: StoredSettings = {
      embedding_top_k: 6,
      vector_threshold: 0.5,
      rerank_model_id: "",
      future_upstream_field: "keep-me",
    };
    const { client, fetch } = makeClient((_path, init) => {
      if (init.method === "PUT") {
        stored = parseBody(init.body) as StoredSettings;
        return { data: stored, success: true };
      }
      return { data: stored };
    });
    await client.updateRetrievalSettings({ vectorThreshold: 0.75 });
    // 上游未知字段必须保留
    expect(stored.future_upstream_field).toBe("keep-me");
    expect(stored.vector_threshold).toBe(0.75);
    expect(stored.embedding_top_k).toBe(6);
    // PUT body 是直接字段（非 {data:...} 包装），且没有丢任何字段
    const putCall = fetch.mock.calls.find(([, init]) => init.method === "PUT");
    expect(putCall).toBeDefined();
    const body = parseBody(putCall?.[1].body);
    expect(body.vector_threshold).toBe(0.75);
    expect(body.future_upstream_field).toBe("keep-me");
    expect("data" in body).toBe(false);
  });

  it("only writes whitelisted client fields", async () => {
    let stored: StoredSettings = {
      embedding_top_k: 6,
      vector_threshold: 0.5,
      future_upstream_field: "keep-me",
    };
    const { client } = makeClient((_path, init) => {
      if (init.method === "PUT") {
        stored = parseBody(init.body) as StoredSettings;
        return { data: stored, success: true };
      }
      return { data: stored };
    });
    await client.updateRetrievalSettings({ embeddingTopK: 10 });
    expect(stored.embedding_top_k).toBe(10);
    expect(stored.vector_threshold).toBe(0.5);
    expect(stored.future_upstream_field).toBe("keep-me");
  });
});

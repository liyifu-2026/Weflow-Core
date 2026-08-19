import { describe, expect, it, vi } from "vitest";
import type { WeKnoraKnowledgeClient } from "../infrastructure/knowledge/weknora-knowledge-client.js";
import { WeKnoraKnowledgeProvider } from "../infrastructure/knowledge/weknora-knowledge-provider.js";

describe("WeKnoraKnowledgeProvider", () => {
  it("maps the provider-neutral query without exposing the client to callers", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        chunkId: "chunk-1",
        knowledgeId: "doc-1",
        knowledgeBaseId: "kb-1",
        title: "故障排查",
        filename: "faq.md",
        source: "faq",
        chunkType: "text",
        content: "重启客户端",
        matchedContent: "重启客户端",
        score: 0.91,
        startAt: 0,
        endAt: 6,
      },
    ]);
    const client = { search } as unknown as WeKnoraKnowledgeClient;
    const provider = new WeKnoraKnowledgeProvider(client);

    await expect(
      provider.search({
        query: "客户端打不开",
        knowledgeBaseIds: ["kb-1"],
        knowledgeIds: ["doc-1"],
        limit: 3,
      }),
    ).resolves.toHaveLength(1);
    expect(search).toHaveBeenCalledWith("客户端打不开", {
      knowledgeBaseIds: ["kb-1"],
      knowledgeIds: ["doc-1"],
      limit: 3,
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { WeKnoraKnowledgeClient } from "../infrastructure/knowledge/weknora-knowledge-client.js";

describe("WeKnoraKnowledgeClient", () => {
  it("discovers accessible knowledge bases and returns bounded source evidence", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ data: [{ id: "kb-a" }, { id: "kb-b" }] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: [
            {
              id: "chunk-1",
              knowledge_id: "doc-1",
              knowledge_title: "V9 指南",
              knowledge_filename: "V9.pdf",
              content: "请先检查软件服务是否启动。",
              score: 0.92,
              start_at: 12,
              end_at: 26,
            },
          ],
        }),
      );
    const client = new WeKnoraKnowledgeClient({
      baseUrl: "http://weknora.test/api/v1",
      apiKey: "test-key",
      timeoutMs: 1_000,
      fetch,
    });

    await expect(client.search("V9 无法启动")).resolves.toEqual([
      {
        chunkId: "chunk-1",
        knowledgeId: "doc-1",
        knowledgeBaseId: "",
        title: "V9 指南",
        filename: "V9.pdf",
        source: "",
        chunkType: "",
        content: "请先检查软件服务是否启动。",
        matchedContent: "",
        score: 0.92,
        startAt: 12,
        endAt: 26,
      },
    ]);
    expect(fetch).toHaveBeenLastCalledWith(
      "http://weknora.test/api/v1/knowledge-search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          query: "V9 无法启动",
          knowledge_base_ids: ["kb-a", "kb-b"],
        }),
      }),
    );
    const request = fetch.mock.calls[1]?.[1];
    expect(request?.headers).toBeInstanceOf(Headers);
    expect((request?.headers as Headers).get("x-api-key")).toBe("test-key");
  });

  it("uses an explicit allow-list without discovering other knowledge bases", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, data: [] }));
    const client = new WeKnoraKnowledgeClient({
      baseUrl: "http://weknora.test/api/v1",
      apiKey: "test-key",
      timeoutMs: 1_000,
      knowledgeBaseIds: ["kb-approved"],
      fetch,
    });

    await expect(client.search("校准")).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caps deep retrieval evidence at the requested limit", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      id: `chunk-${String(index)}`,
      knowledge_id: `doc-${String(index)}`,
      knowledge_title: `文档 ${String(index)}`,
      content: `内容 ${String(index)}`,
    }));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, data: rows }))
      .mockResolvedValueOnce(Response.json({ success: true, data: rows }));
    const client = new WeKnoraKnowledgeClient({
      baseUrl: "http://weknora.test/api/v1",
      apiKey: "test-key",
      timeoutMs: 1_000,
      knowledgeBaseIds: ["kb-approved"],
      fetch,
    });

    await expect(client.search("V9", { limit: 12 })).resolves.toHaveLength(12);
    await expect(client.search("V9")).resolves.toHaveLength(6);
  });

  it("passes selected knowledge files and tags to the scoped search", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ success: true, data: [] }));
    const client = new WeKnoraKnowledgeClient({
      baseUrl: "http://weknora.test/api/v1",
      apiKey: "test-key",
      timeoutMs: 1_000,
      knowledgeBaseIds: ["kb-approved"],
      fetch,
    });

    await client.search("错误 2272", {
      knowledgeIds: ["doc-v9"],
      tagIds: ["tag-install"],
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://weknora.test/api/v1/knowledge-search",
      expect.objectContaining({
        body: JSON.stringify({
          query: "错误 2272",
          knowledge_base_ids: ["kb-approved"],
          knowledge_ids: ["doc-v9"],
          tag_ids: ["tag-install"],
        }),
      }),
    );
  });

  it("creates a private session, opens QA streaming, and stops by message", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ data: { id: "session-1" } }))
      .mockResolvedValueOnce(
        new Response(
          'data: {"response_type":"answer","content":"检查文件"}\n\n',
        ),
      )
      .mockResolvedValueOnce(Response.json({ success: true }));
    const client = new WeKnoraKnowledgeClient({
      baseUrl: "http://weknora.test/api/v1",
      apiKey: "test-key",
      timeoutMs: 1_000,
      fetch,
    });

    await expect(client.createSession()).resolves.toBe("session-1");
    const stream = await client.streamKnowledgeQA("session-1", "错误 2272");
    await expect(stream.text()).resolves.toContain("检查文件");
    await expect(
      client.stopSession("session-1", "message-1"),
    ).resolves.toBeUndefined();
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "http://weknora.test/api/v1/knowledge-chat/session-1",
    );
    expect(fetch.mock.calls[2]?.[0]).toBe(
      "http://weknora.test/api/v1/sessions/session-1/stop",
    );
  });

  it("loads session history and normalizes follow-up suggestions", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: [
            {
              id: "message-1",
              role: "assistant",
              content: "先检查隔离区。",
              created_at: "2026-08-04T04:00:00Z",
              is_completed: true,
              knowledge_references: [{ id: "chunk-1", score: 0.9 }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            id: "suggestion-set-1",
            status: "ready",
            questions: [{ id: "question-1", text: "恢复后仍无法启动怎么办？" }],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true }));
    const client = new WeKnoraKnowledgeClient({
      baseUrl: "http://weknora.test/api/v1",
      apiKey: "test-key",
      timeoutMs: 1_000,
      fetch,
    });

    await expect(client.loadMessages("session-1")).resolves.toEqual([
      {
        id: "message-1",
        role: "assistant",
        content: "先检查隔离区。",
        createdAt: "2026-08-04T04:00:00Z",
        completed: true,
        references: [{ id: "chunk-1", score: 0.9 }],
      },
    ]);
    await expect(
      client.ensureSuggestions("session-1", "message-1"),
    ).resolves.toEqual({
      id: "suggestion-set-1",
      status: "ready",
      questions: [{ id: "question-1", text: "恢复后仍无法启动怎么办？" }],
    });
    await client.recordSuggestionEvent(
      "session-1",
      "suggestion-set-1",
      "question-1",
      "click",
    );
    expect(fetch.mock.calls[2]?.[0]).toBe(
      "http://weknora.test/api/v1/sessions/session-1/suggestion-events",
    );
  });

  it("marks wiki capability from the knowledge base payload", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json({
        data: [
          {
            id: "kb-doc",
            name: "文档库",
            type: "document",
            capabilities: { wiki: false },
          },
          {
            id: "kb-wiki",
            name: "Wiki 库",
            type: "document",
            capabilities: { wiki: true },
          },
        ],
      }),
    );
    const client = new WeKnoraKnowledgeClient({
      baseUrl: "http://weknora.test/api/v1",
      apiKey: "test-key",
      timeoutMs: 1_000,
      fetch,
    });

    await expect(client.listKnowledgeBases()).resolves.toEqual([
      {
        id: "kb-doc",
        name: "文档库",
        type: "document",
        description: "",
        wikiEnabled: false,
      },
      {
        id: "kb-wiki",
        name: "Wiki 库",
        type: "document",
        description: "",
        wikiEnabled: true,
      },
    ]);
  });

  it("lists wiki page metadata with pagination", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json({
        pages: [
          {
            id: "page-1",
            slug: "entity/apx500",
            title: "APx500",
            page_type: "entity",
            summary: "音频分析仪软件",
            category_path: ["测试设备"],
            updated_at: "2026-08-04T00:00:00Z",
          },
        ],
        total: 1,
      }),
    );
    const client = new WeKnoraKnowledgeClient({
      baseUrl: "http://weknora.test/api/v1",
      apiKey: "test-key",
      timeoutMs: 1_000,
      fetch,
    });

    await expect(client.listWikiPages("kb-1")).resolves.toEqual([
      {
        pageId: "page-1",
        knowledgeBaseId: "kb-1",
        slug: "entity/apx500",
        title: "APx500",
        pageType: "entity",
        summary: "音频分析仪软件",
        categoryPath: ["测试设备"],
        updatedAt: "2026-08-04T00:00:00Z",
      },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "http://weknora.test/api/v1/knowledgebase/kb-1/wiki/pages?page=1&page_size=100",
      expect.objectContaining({}),
    );
  });

  it("loads a wiki page body by slug and truncates overlong content", async () => {
    const long = "x".repeat(250_000);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ content: long, slug: "entity/apx500" }),
      );
    const client = new WeKnoraKnowledgeClient({
      baseUrl: "http://weknora.test/api/v1",
      apiKey: "test-key",
      timeoutMs: 1_000,
      fetch,
    });

    const result = await client.getWikiPageContent("kb-1", "entity/apx500");
    expect(result.content).toHaveLength(200_000);
    expect(result.truncated).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "http://weknora.test/api/v1/knowledgebase/kb-1/wiki/pages/entity/apx500",
      expect.objectContaining({}),
    );
  });
});

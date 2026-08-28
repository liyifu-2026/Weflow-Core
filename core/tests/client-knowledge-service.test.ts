import { describe, expect, it, vi } from "vitest";
import {
  applyKnowledgeContextOverride,
  buildKnowledgeActionOutput,
  generateKnowledgeAnswerFromEvidence,
  getKnowledgeLibrary,
  projectAgentKnowledgeEvidence,
  groupKnowledgeSources,
  resolveKnowledgeEvidence,
  searchKnowledgeWorkspace,
} from "../modules/knowledge/application/client-knowledge-service.js";
import type {
  KnowledgeChatCompletionModel,
  KnowledgeChatMessage,
  KnowledgeProvider,
  KnowledgeSearchOptions,
} from "../modules/knowledge/contracts/knowledge-search.js";

/** 目录聚合所需的最小 Provider 面（与服务的窄化签名对齐）。 */
type LibraryClient = Pick<
  KnowledgeProvider,
  | "listKnowledgeBases"
  | "listKnowledgeDocuments"
  | "listKnowledgeTags"
  | "listFaqEntries"
  | "listWikiPages"
>;

describe("client knowledge source grouping", () => {
  it("groups chunks by document and keeps source metadata without raw scores", () => {
    const sources = groupKnowledgeSources([
      {
        chunkId: "chunk-1",
        knowledgeId: "doc-1",
        knowledgeBaseId: "kb-v9",
        title: "V9 安装手册",
        filename: "v9.pdf",
        source: "file",
        chunkType: "text",
        content: "先检查隔离区。",
        matchedContent: "隔离区",
        score: 0.91,
        startAt: 10,
        endAt: 20,
      },
      {
        chunkId: "chunk-2",
        knowledgeId: "doc-1",
        knowledgeBaseId: "kb-v9",
        title: "V9 安装手册",
        filename: "v9.pdf",
        source: "file",
        chunkType: "text",
        content: "恢复文件后重新安装。",
        matchedContent: "重新安装",
        score: 0.78,
        startAt: 21,
        endAt: 30,
      },
    ]);

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      knowledgeId: "doc-1",
      matchCount: 2,
      evidenceLevel: "strong",
    });
    expect(sources[0]?.matches).toHaveLength(2);
    expect(sources[0]?.matches[0]).not.toHaveProperty("score");
    expect(sources[0]?.matches[0]).toMatchObject({
      evidenceId: "chunk-1",
      chunkId: "chunk-1",
      documentId: "doc-1",
      knowledgeBaseId: "kb-v9",
    });
  });
});

describe("context override boundary", () => {
  const base = {
    conversationId: "conv-1",
    revision: 3,
    handoffId: "cycle-1",
    assignedUserId: "user-1",
    product: "V9",
    errorCode: "E100",
    problemSummary: "无法恢复文件",
    hasStructuredBriefing: true,
    confirmedFacts: [{ key: "product", label: "产品", value: "V9" }],
    triedSteps: ["重启设备"],
    missingInformation: [{ key: "model", label: "型号" }],
  };

  it("replaces every editable field when the override is complete", () => {
    const result = applyKnowledgeContextOverride(base, {
      product: "V10",
      errorCode: null,
      triedSteps: ["重启设备", "恢复出厂"],
      confirmedFacts: ["客户已重装"],
      missingInformation: ["购买渠道"],
    });
    expect(result.product).toBe("V10");
    expect(result.errorCode).toBeNull();
    expect(result.triedSteps).toEqual(["重启设备", "恢复出厂"]);
    expect(result.confirmedFacts).toEqual([
      { key: "override_0", label: "客服本次补充", value: "客户已重装" },
    ]);
    expect(result.missingInformation).toEqual([
      { key: "override_missing_0", label: "购买渠道" },
    ]);
    expect(result.revision).toBe(3);
  });

  it("keeps base fields when the override is partial", () => {
    const result = applyKnowledgeContextOverride(base, {
      confirmedFacts: ["客户已重装"],
    });
    expect(result.product).toBe("V9");
    expect(result.errorCode).toBe("E100");
    expect(result.triedSteps).toEqual(["重启设备"]);
    expect(result.confirmedFacts[0]?.value).toBe("客户已重装");
    expect(result.missingInformation).toEqual([
      { key: "model", label: "型号" },
    ]);
  });

  it("attaches recent messages only when requested", () => {
    expect(
      applyKnowledgeContextOverride(base, undefined, "客户：你好"),
    ).toHaveProperty("recentMessages", "客户：你好");
    expect(applyKnowledgeContextOverride(base, undefined)).not.toHaveProperty(
      "recentMessages",
    );
  });
});

describe("client knowledge action output", () => {
  it("normalizes structured actions and keeps reference ids", async () => {
    const model = {
      complete: () =>
        Promise.resolve(
          JSON.stringify({
            reply: "建议先恢复文件。",
            followUps: ["隔离区里还能看到文件吗？"],
            troubleshootingSteps: ["确认安全软件白名单"],
            risks: ["不要重复发送未知结果的请求"],
            referenceIds: ["chunk-1"],
          }),
        ),
    } satisfies KnowledgeChatCompletionModel;
    await expect(
      buildKnowledgeActionOutput(model, {
        answer: "原始回答",
        references: [{ evidenceId: "chunk-1" }],
      }),
    ).resolves.toMatchObject({
      reply: "建议先恢复文件。",
      followUps: ["隔离区里还能看到文件吗？"],
      referenceIds: ["chunk-1"],
      fallback: false,
    });
  });

  it("uses a text fallback when the model returns non-json", async () => {
    const model = {
      complete: () => Promise.resolve("普通文本回答"),
    } satisfies KnowledgeChatCompletionModel;
    await expect(
      buildKnowledgeActionOutput(model, {
        answer: "普通文本回答",
        references: [],
      }),
    ).resolves.toMatchObject({ reply: "普通文本回答", fallback: true });
  });
});

describe("client knowledge library", () => {
  it("aggregates wiki pages only for wiki-enabled knowledge bases", async () => {
    const weknora = {
      listKnowledgeBases: () =>
        Promise.resolve([
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
        ]),
      listKnowledgeDocuments: (kbId: string) =>
        Promise.resolve(
          kbId === "kb-doc"
            ? [
                {
                  knowledgeId: "doc-1",
                  title: "手册",
                  filename: "handbook.pdf",
                  fileType: "pdf",
                  fileSize: 10,
                  parseStatus: "completed",
                  source: "file",
                  tags: [],
                  updatedAt: undefined,
                },
              ]
            : [],
        ),
      listKnowledgeTags: () => Promise.resolve([]),
      listFaqEntries: () => Promise.resolve([]),
      listWikiPages: (kbId: string) =>
        Promise.resolve(
          kbId === "kb-wiki"
            ? [
                {
                  pageId: "page-1",
                  knowledgeBaseId: "kb-wiki",
                  slug: "entity/apx500",
                  title: "APx500",
                  pageType: "entity",
                  summary: "音频分析仪",
                  categoryPath: ["测试设备"],
                  updatedAt: undefined,
                },
              ]
            : [],
        ),
    } satisfies LibraryClient;

    const result = await getKnowledgeLibrary(weknora);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const groups = result.library.knowledgeBases;
    expect(groups).toHaveLength(2);
    expect(groups[0]?.wikiPages).toEqual([]);
    expect(groups[1]?.wikiPages).toHaveLength(1);
    expect(groups[1]?.wikiPages[0]).toMatchObject({
      pageId: "page-1",
      slug: "entity/apx500",
    });
  });

  it("keeps the library available when a wiki directory fails", async () => {
    const weknora = {
      listKnowledgeBases: () =>
        Promise.resolve([
          {
            id: "kb-wiki",
            name: "Wiki 库",
            type: "document",
            description: "",
            wikiEnabled: true,
          },
        ]),
      listKnowledgeDocuments: () => Promise.resolve([]),
      listKnowledgeTags: () => Promise.resolve([]),
      listFaqEntries: () => Promise.resolve([]),
      listWikiPages: () =>
        Promise.reject(new Error("weknora_request_failed:500")),
    } satisfies LibraryClient;

    const result = await getKnowledgeLibrary(weknora);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const group = result.library.knowledgeBases[0];
    expect(group?.wikiPages).toEqual([]);
    expect(group?.error).toBeUndefined();
  });
});

describe("client knowledge workspace search depth", () => {
  it("maps deep mode to a wider evidence limit", async () => {
    const rows = Array.from({ length: 15 }, (_, index) => ({
      chunkId: `chunk-${String(index)}`,
      knowledgeId: `doc-${String(index)}`,
      knowledgeBaseId: "kb-1",
      title: `文档 ${String(index)}`,
      filename: `doc-${String(index)}.pdf`,
      source: "file",
      chunkType: "text",
      content: `内容 ${String(index)}`,
      matchedContent: `内容 ${String(index)}`,
      score: 0.9,
      startAt: 0,
      endAt: 1,
    }));
    const weknora = {
      search: vi.fn(() => Promise.resolve(rows.slice(0, 12))),
    } satisfies Pick<KnowledgeProvider, "search">;
    const db = { insert: () => ({ values: () => Promise.resolve() }) } as never;

    const quick = await searchKnowledgeWorkspace(db, weknora, {
      userId: "user-1",
      query: "V9",
      sourceIp: "127.0.0.1",
    });
    expect(quick.status).toBe("ok");
    if (quick.status !== "ok") return;
    expect(quick.result.sources).toHaveLength(12);
  });

  it("defaults to the quick evidence window", async () => {
    let requestedLimit: number | undefined;
    const weknora = {
      search: vi.fn((_query: string, options?: KnowledgeSearchOptions) => {
        requestedLimit = options?.limit;
        return Promise.resolve([]);
      }),
    } satisfies Pick<KnowledgeProvider, "search">;
    const db = { insert: () => ({ values: () => Promise.resolve() }) } as never;

    await searchKnowledgeWorkspace(db, weknora, {
      userId: "user-1",
      query: "V9",
      sourceIp: "127.0.0.1",
    });
    await searchKnowledgeWorkspace(db, weknora, {
      userId: "user-1",
      query: "V9",
      sourceIp: "127.0.0.1",
      depth: "deep",
    });
    expect(requestedLimit).toBe(12);
  });
});

describe("trusted evidence boundary", () => {
  it("projects only safe fields from a successful Agent retrieval", () => {
    const result = projectAgentKnowledgeEvidence({
      executionId: "tool-1",
      retrievedAt: new Date("2026-08-18T00:00:00.000Z"),
      result: {
        evidence: [
          {
            chunkId: "chunk-2272",
            knowledgeId: "doc-v9",
            knowledgeBaseId: "kb-support",
            title: "V9 故障手册",
            filename: "v9.pdf",
            content: "检查杀毒软件隔离区。",
            matchedContent: "隔离区",
            score: 0.99,
            internalPath: "C:/should-not-leak",
            startAt: 10,
            endAt: 20,
          },
          { chunkId: "missing-required-fields" },
        ],
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        evidenceId: "chunk-2272",
        documentId: "doc-v9",
        excerpt: "检查杀毒软件隔离区。",
        provenance: "agent_retrieval",
        sourceExecutionId: "tool-1",
        retrievedAt: "2026-08-18T00:00:00.000Z",
        locator: "片段 10-20",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("internalPath");
    expect(JSON.stringify(result)).not.toContain("score");
  });

  it("resolves only the exact chunk returned for the requested document", async () => {
    const model = {
      search: () =>
        Promise.resolve([
          {
            chunkId: "chunk-1",
            knowledgeId: "doc-1",
            knowledgeBaseId: "kb-1",
            title: "V9 手册",
            filename: "v9.pdf",
            source: "file",
            chunkType: "text",
            content: "可信片段",
            matchedContent: "可信片段",
            score: 0.9,
            startAt: 1,
            endAt: 2,
          },
        ]),
    } satisfies Pick<KnowledgeProvider, "search">;
    await expect(
      resolveKnowledgeEvidence(
        model,
        [{ chunkId: "chunk-1", knowledgeId: "doc-1" }],
        "user-1",
      ),
    ).resolves.toMatchObject([
      { evidenceId: "chunk-1", excerpt: "可信片段", addedBy: "user-1" },
    ]);
    await expect(
      resolveKnowledgeEvidence(
        model,
        [{ chunkId: "chunk-2", knowledgeId: "doc-1" }],
        "user-1",
      ),
    ).rejects.toThrow("knowledge_evidence_not_found");
  });

  it("passes only trusted tray snapshots to selected-evidence generation", async () => {
    let prompt = "";
    const model = {
      complete: (messages: KnowledgeChatMessage[]) => {
        prompt = messages[1]?.content ?? "";
        return Promise.resolve("只基于托盘回答");
      },
    } satisfies KnowledgeChatCompletionModel;
    await generateKnowledgeAnswerFromEvidence(model, {
      query: "怎么处理？",
      evidence: [
        {
          evidenceId: "chunk-1",
          documentId: "doc-1",
          knowledgeBaseId: "kb-1",
          title: "手册",
          sourceName: "manual.pdf",
          excerpt: "只允许使用这段",
          addedBy: "user-1",
          addedAt: "2026-08-04T00:00:00.000Z",
          sourceHash: "hash",
        },
      ],
    });
    expect(prompt).toContain("只允许使用这段");
    expect(prompt).not.toContain("托盘外的资料");
  });
});

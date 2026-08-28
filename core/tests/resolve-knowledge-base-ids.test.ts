import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveKnowledgeBaseIds } from "../modules/knowledge/application/client-knowledge-service.js";
import type { KnowledgeProvider } from "../modules/knowledge/contracts/knowledge-search.js";

const listKB = vi.fn();
const client = {
  listKnowledgeBases: listKB,
} satisfies Pick<KnowledgeProvider, "listKnowledgeBases">;

/** 模块级 60s 缓存在用例间会串扰：用假时钟把时间拉开，保证每个用例拿到干净缓存 */
const T0 = new Date("2026-08-13T00:00:00.000Z");

function at(offsetMs: number) {
  vi.mocked(Date.now).mockReturnValue(T0.getTime() + offsetMs);
}

beforeEach(() => {
  vi.spyOn(Date, "now");
  listKB.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveKnowledgeBaseIds（建议回复默认知识库）", () => {
  it("调用方显式指定时原样返回，不请求列表接口", async () => {
    const ids = await resolveKnowledgeBaseIds(client, ["kb-a", "kb-b"]);
    expect(ids).toEqual(["kb-a", "kb-b"]);
    expect(listKB).not.toHaveBeenCalled();
  });

  it("无缓存且列表失败时回落到空列表（退化为不检索，不阻断生成）", async () => {
    at(0);
    listKB.mockRejectedValue(new Error("upstream down"));
    await expect(resolveKnowledgeBaseIds(client)).resolves.toEqual([]);
  });

  it("未指定时返回租户全部知识库 ID", async () => {
    at(120_000);
    listKB.mockResolvedValue([
      { id: "kb-1", name: "指南知识库", type: "document", description: "" },
      { id: "kb-2", name: "FAQ", type: "document", description: "" },
    ]);
    const ids = await resolveKnowledgeBaseIds(client);
    expect(ids).toEqual(["kb-1", "kb-2"]);
  });

  it("列表失败时回落到缓存（陈旧列表优于放弃检索），不抛错", async () => {
    // 先填充缓存（时间单调推进，绕开上一用例的缓存窗口）
    at(240_000);
    listKB.mockResolvedValue([
      { id: "kb-1", name: "指南知识库", type: "document", description: "" },
    ]);
    await resolveKnowledgeBaseIds(client);
    // 越过缓存窗口后列表失败：回落陈旧缓存
    at(360_000);
    listKB.mockRejectedValue(new Error("upstream down"));
    await expect(resolveKnowledgeBaseIds(client)).resolves.toEqual(["kb-1"]);
  });

  it("60 秒内重复调用命中缓存", async () => {
    at(480_000);
    listKB.mockResolvedValue([
      { id: "kb-cached", name: "缓存库", type: "document", description: "" },
    ]);
    await resolveKnowledgeBaseIds(client);
    await resolveKnowledgeBaseIds(client);
    expect(listKB).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  buildSystemPrompt,
  collectSkillHints,
  collectSkillHintsAfterKnowledge,
  resolveExecutionStrategy,
} from "../modules/agent/application/reply-policy.js";
import type { SkillRegistry } from "../modules/agent/contracts/agent-skill.js";
import type { ExecutionStrategyRegistry } from "../modules/agent/contracts/execution-strategy.js";

// mock execution-profile-service：resolveExecutionStrategy 的 profile 分支依赖它
vi.mock("../modules/agent/application/execution-profile-service.js", () => ({
  findExecutionProfileById: vi.fn(async (_db: unknown, id: string | null) =>
    id === "profile-with-strategy" ? { strategyRef: "strategy-a" } : undefined,
  ),
}));

describe("reply-policy buildSystemPrompt", () => {
  it("默认（私聊、无知识库）不含 knowledge/群聊提示", () => {
    const prompt = buildSystemPrompt(false);
    expect(prompt).toContain("你是 Weflow 平台上的通用会话代理");
    expect(prompt).not.toContain("retrieve_knowledge 时提供 knowledge_query");
    expect(prompt).not.toContain("群聊场景");
  });

  it("知识库可用时追加 knowledge_query 约束", () => {
    const prompt = buildSystemPrompt(true);
    expect(prompt).toContain("retrieve_knowledge 时提供 knowledge_query");
    expect(prompt).toContain("不要编造知识内容");
  });

  it("群聊时追加简洁回复约束", () => {
    const prompt = buildSystemPrompt(false, "group");
    expect(prompt).toContain("当前为群聊场景");
    expect(prompt).toContain("回复应简洁");
    expect(prompt).toContain("不得包含私人信息");
  });

  it("输出格式约束始终存在（JSON-only 契约）", () => {
    const prompt = buildSystemPrompt(false);
    expect(prompt).toContain("只输出 JSON");
    expect(prompt).toContain("reply_segments");
    expect(prompt).toContain("next_action");
  });
});

describe("reply-policy resolveExecutionStrategy", () => {
  function registryWith(entries: Record<string, unknown>): ExecutionStrategyRegistry {
    return {
      get: (ref: string) => entries[ref] as never,
      list: () => Object.values(entries) as never,
      has: (ref: string) => ref in entries,
      register: (() => undefined) as never,
    };
  }

  it("无注册表 → undefined（走内置提示词）", async () => {
    const strategy = await resolveExecutionStrategy(
      {} as never,
      { executionProfileId: null },
      undefined,
    );
    expect(strategy).toBeUndefined();
  });

  it("无 executionProfileId → 回退注册表首个策略", async () => {
    const registry = registryWith({ a: { id: "strategy-a" }, b: { id: "strategy-b" } });
    const strategy = await resolveExecutionStrategy(
      {} as never,
      { executionProfileId: null },
      registry,
    );
    expect(strategy).toMatchObject({ id: "strategy-a" });
  });

  it("executionProfileId 命中 profile → 按 strategyRef 解析", async () => {
    const registry = registryWith({ "strategy-a": { id: "by-ref" } });
    const strategy = await resolveExecutionStrategy(
      {} as never,
      { executionProfileId: "profile-with-strategy" },
      registry,
    );
    expect(strategy).toMatchObject({ id: "by-ref" });
  });

  it("profile 未命中注册表 → 回退首个策略", async () => {
    const registry = registryWith({ other: { id: "fallback" } });
    const strategy = await resolveExecutionStrategy(
      {} as never,
      { executionProfileId: "profile-with-strategy" },
      registry,
    );
    expect(strategy).toMatchObject({ id: "fallback" });
  });
});

function fakeSkillRegistry(
  skills: Array<{
    id: string;
    version: string;
    beforeKnowledge?: () => unknown;
    afterKnowledge?: () => unknown;
  }>,
): SkillRegistry {
  return {
    list: () => skills as never,
    get: (() => undefined) as never,
    has: (() => false) as never,
    register: (() => undefined) as never,
  };
}

describe("reply-policy collectSkillHints", () => {
  const history = [
    { role: "user" as const, content: "v9软件打不开" },
    { role: "assistant" as const, content: "请稍等" },
  ];

  it("无注册表 → 空数组", () => {
    expect(collectSkillHints(undefined, history)).toEqual([]);
  });

  it("收集 beforeKnowledge 输出并带上 id@version 前缀", () => {
    const hints = collectSkillHints(
      fakeSkillRegistry([
        { id: "kb-guide", version: "1.0.0", beforeKnowledge: () => ({ tip: "查错误 2272" }) },
      ]),
      history,
    );
    expect(hints).toEqual(['kb-guide@1.0.0: {"tip":"查错误 2272"}']);
  });

  it("跳过无 beforeKnowledge 的 Skill 与抛异常的 Skill", () => {
    const hints = collectSkillHints(
      fakeSkillRegistry([
        { id: "no-hook", version: "1.0.0" },
        { id: "throws", version: "1.0.0", beforeKnowledge: () => { throw new Error("boom"); } },
        { id: "ok", version: "2.0.0", beforeKnowledge: () => "hint" },
      ]),
      history,
    );
    expect(hints).toEqual(["ok@2.0.0: \"hint\""]);
  });
});

describe("reply-policy collectSkillHintsAfterKnowledge", () => {
  const evidence = [{ chunkId: "c1" }] as never;
  const history = [{ role: "user" as const, content: "v9软件打不开" }];

  it("收集 afterKnowledge 输出（带 evidence）", () => {
    const hints = collectSkillHintsAfterKnowledge(
      fakeSkillRegistry([
        { id: "kb-guide", version: "1.0.0", afterKnowledge: () => ({ evidenceCount: 1 }) },
      ]),
      evidence,
      history,
    );
    expect(hints).toEqual(['kb-guide@1.0.0: {"evidenceCount":1}']);
  });

  it("无 afterKnowledge 的 Skill 不产生提示", () => {
    const hints = collectSkillHintsAfterKnowledge(
      fakeSkillRegistry([{ id: "no-hook", version: "1.0.0" }]),
      evidence,
      history,
    );
    expect(hints).toEqual([]);
  });
});

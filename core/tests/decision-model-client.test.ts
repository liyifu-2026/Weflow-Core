/**
 * 决策模型客户端单测：注入 fetch，验证响应收敛、错误折叠（永不抛错）、
 * 超时与 URL 拼接。协议样例依据百炼 System One 文档（2026-09-30）。
 */
import { describe, expect, it } from "vitest";
import {
  callDecisionModel,
  readChoiceProbability,
  readDecisionConfidence,
  readNoulProbability,
} from "../infrastructure/model_runtime/decision-model-client.js";

const endpoint = {
  baseUrl: "https://example.maas.aliyuncs.com/",
  apiKey: "sk-test",
  model: "decision-model-preview-2026-09-24",
  timeoutMs: 500,
};

const okBody = {
  answers: {
    q_need_human: { answer: 0.12, confidence: 0.4 },
    q_tier: {
      answer: "simple",
      probabilities: { simple: 0.91, standard: 0.07, other: 0.02 },
      confidence: 0.88,
    },
  },
  usage: { input_tokens: 168 },
  model: "decision-model-preview-2026-09-24",
  latency_ms: 58.3,
};

describe("decision model client", () => {
  it("parses a successful systemone response", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(okBody), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await callDecisionModel(endpoint, {
      state: { trigger: "您好", recent: [] },
      questions: { q_need_human: { type: "noul" } },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputTokens).toBe(168);
    expect(result.latencyMs).toBeCloseTo(58.3);
    expect(result.model).toBe("decision-model-preview-2026-09-24");
    expect(readNoulProbability(result.answers.q_need_human)).toBeCloseTo(0.12);
    expect(readChoiceProbability(result.answers.q_tier, "simple")).toBeCloseTo(
      0.91,
    );
    expect(readDecisionConfidence(result.answers.q_tier)).toBeCloseTo(0.88);
    // URL 拼接：尾斜杠去除 + 路径与 Bearer 头
    expect(calls[0]?.url).toBe(
      "https://example.maas.aliyuncs.com/compatible-mode/v1/systemone",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      model: string;
      state: unknown;
    };
    expect(body.model).toBe("decision-model-preview-2026-09-24");
  });

  it("folds http errors into failed without throwing", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const result = await callDecisionModel(endpoint, {
      state: "x",
      questions: { q: { type: "noul" } },
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, errorCode: "http_500" });
  });

  it("folds network failures into failed", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const result = await callDecisionModel(endpoint, {
      state: "x",
      questions: { q: { type: "noul" } },
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe("network");
  });

  it("folds aborts into timeout", async () => {
    const fetchImpl = (async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;
    const result = await callDecisionModel(endpoint, {
      state: "x",
      questions: { q: { type: "noul" } },
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, errorCode: "timeout" });
  });

  it("folds malformed bodies into bad_response", async () => {
    const fetchImpl = (async () =>
      new Response('{"answers": "not-an-object"}', {
        status: 200,
      })) as unknown as typeof fetch;
    const result = await callDecisionModel(endpoint, {
      state: "x",
      questions: { q: { type: "noul" } },
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, errorCode: "bad_response" });
  });

  it("keeps raw answer values it cannot shape", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ answers: { q1: { weird: true } } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const result = await callDecisionModel(endpoint, {
      state: "x",
      questions: { q1: { type: "noul" } },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.q1).toEqual({ answer: { weird: true } });
    expect(readNoulProbability(result.answers.q1)).toBeUndefined();
  });

  it("parses the real score shape (criteria array, 0-indexed weighted score)", async () => {
    // 真实抓包（2026-09-30）：score 值在 `score` 字段，legend 按数组下标回带
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          answers: {
            q_urgency: {
              type: "score",
              score: 3.88,
              legend: { 0: "1 很不紧急", 1: "2 不紧急", 2: "3 一般", 3: "4 比较紧急", 4: "5 非常紧急" },
              probabilities: { 0: 0.01, 1: 0.02, 2: 0.09, 3: 0.08, 4: 0.8 },
              confidence: 0.8,
            },
          },
          usage: { input_tokens: 36 },
          model: "decision-model-preview",
          latency_ms: 48.2,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const result = await callDecisionModel(endpoint, {
      state: "x",
      questions: { q_urgency: { type: "score" } },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.q_urgency!.score).toBeCloseTo(3.88);
    expect(result.answers.q_urgency!.answer).toBeCloseTo(3.88);
    expect(readDecisionConfidence(result.answers.q_urgency)).toBeCloseTo(0.8);
  });

  it("parses the real protocol shapes (noul/choice fields, captured 2026-09-30)", async () => {
    // 真实抓包：noul 值在 `noul` 字段、choice 在 `choice` 字段 + probabilities
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: "decision-model-preview",
          request_id: "75a01bf2",
          answers: {
            q_tier: {
              type: "choice",
              choice: "other",
              confidence: 0.8,
              probabilities: { simple: 0.12, standard: 0.01, other: 0.87 },
            },
            q_worth_reply: { type: "noul", noul: 0.42 },
          },
          usage: { input_tokens: 56 },
          latency_ms: 51.8,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const result = await callDecisionModel(endpoint, {
      state: "x",
      questions: { q_tier: { type: "choice" }, q_worth_reply: { type: "noul" } },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readNoulProbability(result.answers.q_worth_reply)).toBeCloseTo(0.42);
    expect(readChoiceProbability(result.answers.q_tier, "other")).toBeCloseTo(
      0.87,
    );
    expect(readChoiceProbability(result.answers.q_tier, "simple")).toBeCloseTo(
      0.12,
    );
    // 归一化 answer：noul → 数值；choice → 选项键
    expect(result.answers.q_worth_reply!.answer).toBeCloseTo(0.42);
    expect(result.answers.q_tier!.answer).toBe("other");
    expect(readDecisionConfidence(result.answers.q_tier)).toBeCloseTo(0.8);
  });
});

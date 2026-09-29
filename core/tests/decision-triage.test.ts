/**
 * 决策模型缝单测：设置提取、问题拼装、阈值映射、worth-reply 边界与
 * fail-open 语义。全部纯函数，无 IO。
 */
import { describe, expect, it } from "vitest";
import type { DecisionAnswer } from "../infrastructure/model_runtime/decision-model-client.js";
import {
  buildDecisionQuestions,
  classifyWithDecisionModel,
  decisionAuditPayload,
  DEFAULT_DECISION_SETTINGS,
  extractDecisionSettings,
  isDecisionSeamActive,
  shouldSkipForWorthReply,
  verdictFromDecision,
  type DecisionSettings,
} from "../modules/agent/application/decision-triage.js";

const endpoint = {
  baseUrl: "https://example.maas.aliyuncs.com",
  apiKey: "sk-test",
  timeoutMs: 500,
};

function settingsWith(
  patch: Partial<DecisionSettings>,
  questions = true,
): DecisionSettings {
  return {
    ...DEFAULT_DECISION_SETTINGS,
    ...patch,
    ...(questions
      ? {
          questions: {
            q_need_human: { type: "noul", instructions: "转人工？" },
            q_tier: {
              type: "choice",
              instructions: "档位？",
              criteria: { simple: "s", standard: "t", other: "o" },
            },
            q_worth_reply: { type: "noul", instructions: "值得回复？" },
          },
        }
      : {}),
  };
}

describe("extractDecisionSettings", () => {
  it("defaults to all-off on missing/malformed input", () => {
    expect(extractDecisionSettings(undefined)).toEqual(
      DEFAULT_DECISION_SETTINGS,
    );
    expect(extractDecisionSettings({ pipeline: {} })).toEqual(
      DEFAULT_DECISION_SETTINGS,
    );
    expect(extractDecisionSettings({ decision: "junk" })).toEqual(
      DEFAULT_DECISION_SETTINGS,
    );
  });

  it("reads switches, clamps thresholds and filters invalid questions", () => {
    const settings = extractDecisionSettings({
      decision: {
        shadowEnabled: true,
        triageEnabled: "yes-not-boolean",
        timeoutMs: 99,
        thresholds: { humanProbability: 1.7, simpleProbability: "x" },
        questions: {
          q_need_human: { type: "noul", instructions: "x" },
          q_bad: { type: "poem" },
          q_tier: "not-an-object",
        },
      },
    });
    expect(settings.shadowEnabled).toBe(true);
    expect(settings.triageEnabled).toBe(false);
    expect(settings.timeoutMs).toBe(DEFAULT_DECISION_SETTINGS.timeoutMs);
    expect(settings.thresholds.humanProbability).toBe(
      // 越界阈值（1.7）回落默认而非钳到 1——钳到 1 会让一切转人工
      DEFAULT_DECISION_SETTINGS.thresholds.humanProbability,
    );
    expect(settings.thresholds.simpleProbability).toBe(
      DEFAULT_DECISION_SETTINGS.thresholds.simpleProbability,
    );
    expect(Object.keys(settings.questions)).toEqual(["q_need_human"]);
  });
});

describe("buildDecisionQuestions / seam activity", () => {
  it("is inactive when every switch is off", () => {
    expect(isDecisionSeamActive(DEFAULT_DECISION_SETTINGS)).toBe(false);
  });

  it("shadow collects all configured questions", () => {
    const settings = settingsWith({ shadowEnabled: true });
    const questions = buildDecisionQuestions(settings);
    expect(Object.keys(questions).sort()).toEqual([
      "q_need_human",
      "q_tier",
      "q_worth_reply",
    ]);
  });

  it("triage-only assembles need_human+tier; worth-only assembles worth_reply", () => {
    expect(
      Object.keys(buildDecisionQuestions(settingsWith({ triageEnabled: true }))),
    ).toEqual(["q_need_human", "q_tier"]);
    expect(
      Object.keys(
        buildDecisionQuestions(settingsWith({ worthReplyEnabled: true })),
      ),
    ).toEqual(["q_worth_reply"]);
  });

  it("active modes with no configured questions assemble nothing (disabled seam)", () => {
    const settings = settingsWith({ triageEnabled: true }, false);
    expect(buildDecisionQuestions(settings)).toEqual({});
  });
});

describe("classifyWithDecisionModel", () => {
  it("returns disabled when all switches are off", async () => {
    const result = await classifyWithDecisionModel({
      endpoint,
      settings: DEFAULT_DECISION_SETTINGS,
      context: { triggerText: "您好", recentInboundTexts: [] },
    });
    expect(result).toEqual({ kind: "disabled" });
  });

  it("skips empty context without calling the endpoint (fail-open guard)", async () => {
    let called = false;
    const result = await classifyWithDecisionModel({
      endpoint,
      settings: settingsWith({ triageEnabled: true }),
      context: { triggerText: "   ", recentInboundTexts: [] },
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: "skipped_empty_context" });
    expect(called).toBe(false);
  });

  it("maps ok responses with audit payload", async () => {
    const result = await classifyWithDecisionModel({
      endpoint,
      settings: settingsWith({ triageEnabled: true }),
      context: { triggerText: "退款", recentInboundTexts: ["在吗"] },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            answers: { q_need_human: { answer: 0.95, confidence: 0.9 } },
            usage: { input_tokens: 120 },
            model: "decision-model-preview",
            latency_ms: 50,
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.inputTokens).toBe(120);
    expect(decisionAuditPayload(result).model).toBe("decision-model-preview");
    // 审计 payload 里没有任何密钥材料
    expect(JSON.stringify(decisionAuditPayload(result))).not.toContain("sk-");
  });

  it("folds endpoint failure into failed with stable code", async () => {
    const result = await classifyWithDecisionModel({
      endpoint,
      settings: settingsWith({ worthReplyEnabled: true }),
      context: { triggerText: "在吗", recentInboundTexts: [] },
      fetchImpl: (async () =>
        new Response("err", { status: 503 })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ kind: "failed", errorCode: "http_503" });
  });
});

describe("verdictFromDecision thresholds", () => {
  const ok = (answers: Record<string, DecisionAnswer>) =>
    ({
      kind: "ok",
      ok: true,
      answers,
      inputTokens: 100,
      latencyMs: 50,
      model: "m",
    }) as const;

  it("routes human at P>=0.85 with sufficient confidence", () => {
    const verdict = verdictFromDecision(
      ok({ q_need_human: { answer: 0.9, confidence: 0.8 } }),
      settingsWith({ triageEnabled: true }),
    );
    expect(verdict.route).toBe("human");
    expect(verdict.reason).toBe("decision_need_human");
  });

  it("refuses human when confidence gate fails (gray zone stays standard)", () => {
    const verdict = verdictFromDecision(
      ok({ q_need_human: { answer: 0.9, confidence: 0.3 } }),
      settingsWith({ triageEnabled: true }),
    );
    expect(verdict.route).toBe("auto");
    expect(verdict.tier).toBe("standard");
  });

  it("treats missing confidence as passing (noul has no promised confidence)", () => {
    const verdict = verdictFromDecision(
      ok({ q_need_human: { answer: 0.9 } }),
      settingsWith({ triageEnabled: true }),
    );
    expect(verdict.route).toBe("human");
  });

  it("routes simple from choice probability without triggering human", () => {
    const verdict = verdictFromDecision(
      ok({
        q_need_human: { answer: 0.1 },
        q_tier: {
          answer: "simple",
          probabilities: { simple: 0.93, standard: 0.05, other: 0.02 },
        },
      }),
      settingsWith({ triageEnabled: true }),
    );
    expect(verdict.route).toBe("auto");
    expect(verdict.tier).toBe("simple");
  });

  it("gray zone falls back to standard", () => {
    const verdict = verdictFromDecision(
      ok({
        q_need_human: { answer: 0.5 },
        q_tier: {
          answer: "standard",
          probabilities: { simple: 0.4, standard: 0.55, other: 0.05 },
        },
      }),
      settingsWith({ triageEnabled: true }),
    );
    expect(verdict.tier).toBe("standard");
    expect(verdict.reason).toBe("decision_standard");
  });
});

describe("shouldSkipForWorthReply", () => {
  const ok = (answers: Record<string, DecisionAnswer>) =>
    ({
      kind: "ok",
      ok: true,
      answers,
      inputTokens: 1,
      latencyMs: 1,
      model: "m",
    }) as const;

  it("skips only when P(worth)<=1-noReplyProbability (default 0.1)", () => {
    const settings = settingsWith({ worthReplyEnabled: true });
    expect(
      shouldSkipForWorthReply(ok({ q_worth_reply: { answer: 0.05 } }), settings),
    ).toBe(true);
    expect(
      shouldSkipForWorthReply(ok({ q_worth_reply: { answer: 0.1 } }), settings),
    ).toBe(true);
    expect(
      shouldSkipForWorthReply(ok({ q_worth_reply: { answer: 0.11 } }), settings),
    ).toBe(false);
  });

  it("never skips on missing/unshaped answers (fail-open to main decision)", () => {
    const settings = settingsWith({ worthReplyEnabled: true });
    expect(shouldSkipForWorthReply(ok({}), settings)).toBe(false);
    expect(
      shouldSkipForWorthReply(ok({ q_worth_reply: { answer: "high" } }), settings),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  dedupeReplySegments,
  validateDecision,
  validateReplySegments,
} from "../modules/agent/application/policy-gate.js";
import { MAX_REPLY_SEGMENTS } from "../modules/agent/application/decision-contract.js";
import { parseAgentDecision } from "../modules/agent/application/agent-decision.js";
import type { AgentDecision } from "../modules/agent/application/agent-decision.js";

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    replySegments: ["好的。"],
    replyText: "好的。",
    nextAction: "reply",
    noActionReason: undefined,
    requiresHuman: false,
    riskLevel: "low",
    handoffBriefing: undefined,
    knowledgeQuery: undefined,
    tool: undefined,
    waitMs: undefined,
    nudgeText: undefined,
    scheduledMessage: undefined,
    scheduledSendAt: undefined,
    closureSummary: undefined,
    factsCard: undefined,
    ...overrides,
  };
}

describe("policy gate — validateDecision", () => {
  it("allows an ordinary low-risk reply", () => {
    expect(validateDecision(decision())).toEqual({ action: "allow" });
  });

  it("hands off when the model requests a human", () => {
    expect(validateDecision(decision({ requiresHuman: true }))).toEqual({
      action: "handoff",
      reasonCode: "model_requested_handoff",
    });
  });

  it("hands off high-risk decisions", () => {
    expect(validateDecision(decision({ riskLevel: "high" }))).toEqual({
      action: "handoff",
      reasonCode: "model_requested_handoff",
    });
  });

  it("hands off explicit handoff actions", () => {
    expect(validateDecision(decision({ nextAction: "handoff" }))).toEqual({
      action: "handoff",
      reasonCode: "model_requested_handoff",
    });
  });

  it("allows medium-risk replies", () => {
    expect(validateDecision(decision({ riskLevel: "medium" }))).toEqual({
      action: "allow",
    });
  });

  it("parses a model decision and gates it", () => {
    const parsed = parseAgentDecision(
      JSON.stringify({
        reply_text: "我来帮您处理。",
        next_action: "reply",
        requires_human: false,
        risk_level: "low",
      }),
    );
    expect(validateDecision(parsed)).toEqual({ action: "allow" });
  });
});

describe("policy gate — validateReplySegments", () => {
  it("caps replies at the platform segment limit", () => {
    expect(validateReplySegments(["第一段", "第二段"])).toEqual([
      "第一段",
      "第二段",
    ]);
    expect(() => validateReplySegments([])).toThrow(
      "reply_segment_count_invalid",
    );
    expect(() =>
      validateReplySegments(
        Array.from({ length: MAX_REPLY_SEGMENTS + 1 }, () => "x"),
      ),
    ).toThrow("reply_segment_count_invalid");
  });

  it("allows multi-step fragmented replies beyond three segments", () => {
    const steps = [
      "断电。",
      "等 10 秒。",
      "重新上电。",
      "看指示灯。",
      "告诉我颜色。",
    ];
    expect(validateReplySegments(steps)).toEqual(steps);
  });

  it("passes duplicate segments through (dedup is a separate,落库边界 step)", () => {
    // 校验器只管「合法不合法」；批内去重在 createAgentReply 落库边界做，
    // 免得调用方只把这里当「会不会抛」的副作用用、返回值一丢就静默失效。
    expect(validateReplySegments(["重插。", "重插。"])).toEqual([
      "重插。",
      "重插。",
    ]);
  });

  it("applies the segment-count guard before dedup", () => {
    // 上限仍按模型原样输出的段数判定：不能靠重复段把 9 段洗成合法批。
    expect(() =>
      validateReplySegments(
        Array.from({ length: MAX_REPLY_SEGMENTS + 1 }, () => "复读。"),
      ),
    ).toThrow("reply_segment_count_invalid");
  });
});

describe("policy gate — dedupeReplySegments", () => {
  it("drops verbatim duplicate segments inside one batch (keeps the first)", () => {
    expect(
      dedupeReplySegments([
        "先看加密狗灯亮不亮",
        "灯亮就换个USB口重插",
        "灯亮就换个USB口重插",
      ]),
    ).toEqual(["先看加密狗灯亮不亮", "灯亮就换个USB口重插"]);
  });

  it("treats whitespace-only differences as the same segment", () => {
    expect(
      dedupeReplySegments([
        "插好再开一次软件，看还报不报2272。",
        "  插好再开一次软件，看还报不报2272。 \n",
      ]),
    ).toEqual(["插好再开一次软件，看还报不报2272。"]);
  });

  it("keeps near-duplicates that are worded differently (only verbatim is deduped)", () => {
    const nearDuplicates = [
      "灯亮就换个USB口重插",
      "灯亮的话，先把加密狗换个USB口重插",
    ];
    expect(dedupeReplySegments(nearDuplicates)).toEqual(nearDuplicates);
  });

  it("keeps the original (untrimmed) text of the first occurrence", () => {
    expect(dedupeReplySegments(["  灯亮就换个USB口重插。  "])).toEqual([
      "  灯亮就换个USB口重插。  ",
    ]);
  });

  it("is a no-op for batches without duplicates", () => {
    const steps = ["断电。", "等 10 秒。", "重新上电。"];
    expect(dedupeReplySegments(steps)).toEqual(steps);
  });
});

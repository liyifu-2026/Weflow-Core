import { describe, expect, it } from "vitest";
import {
  validateDecision,
  validateReplySegments,
} from "../modules/agent/application/policy-gate.js";
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
  it("limits replies to one through three complete segments", () => {
    expect(validateReplySegments(["第一段", "第二段"])).toEqual([
      "第一段",
      "第二段",
    ]);
    expect(() => validateReplySegments([])).toThrow(
      "reply_segment_count_invalid",
    );
    expect(() => validateReplySegments(["x", "x", "x", "x"])).toThrow(
      "reply_segment_count_invalid",
    );
  });
});

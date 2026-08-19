import { describe, expect, it } from "vitest";
import { parseAgentDecision } from "../modules/agent/application/agent-decision.js";
import { getToolPlan } from "../modules/agent/application/tool-plan.js";

describe("bounded tool plan", () => {
  it("creates one idempotent plan for a tool action", () => {
    const decision = parseAgentDecision(
      JSON.stringify({
        reply_text: "我先查询一下。",
        next_action: "call_tool",
        tool: { name: "query_contact_profile", arguments: {} },
        requires_human: false,
        risk_level: "low",
      }),
    );
    expect(getToolPlan(decision, "turn-123")).toEqual({
      name: "query_contact_profile",
      arguments: {},
      idempotencyKey: "agent-tool:turn-123",
    });
  });

  it("does not create a plan for a normal reply", () => {
    const decision = parseAgentDecision(
      JSON.stringify({
        reply_text: "好的。",
        next_action: "reply",
        requires_human: false,
        risk_level: "low",
      }),
    );
    expect(getToolPlan(decision, "turn-123")).toBeNull();
  });

  it("creates a bounded read-only plan for knowledge retrieval", () => {
    const decision = parseAgentDecision(
      JSON.stringify({
        next_action: "retrieve_knowledge",
        knowledge_query: "软件无法启动的排查步骤",
        requires_human: false,
        risk_level: "low",
      }),
    );
    expect(getToolPlan(decision, "turn-456")).toEqual({
      name: "retrieve_knowledge",
      arguments: { query: "软件无法启动的排查步骤" },
      idempotencyKey: "agent-tool:turn-456",
    });
  });

  it("rejects arguments outside the tool contract", () => {
    const decision = parseAgentDecision(
      JSON.stringify({
        reply_text: "我先查一下。",
        next_action: "call_tool",
        tool: {
          name: "query_contact_profile",
          arguments: { contact_id: "other" },
        },
        requires_human: false,
        risk_level: "low",
      }),
    );
    expect(() => getToolPlan(decision, "turn-123")).toThrow(
      "invalid tool arguments",
    );
  });

  it("throws tool_not_in_catalog for tools outside the platform catalog", () => {
    const decision = parseAgentDecision(
      JSON.stringify({
        reply_text: "我先查一下。",
        next_action: "call_tool",
        tool: { name: "refund_money", arguments: {} },
        requires_human: false,
        risk_level: "low",
      }),
    );
    expect(() => getToolPlan(decision, "turn-123")).toThrow(
      "tool_not_in_catalog",
    );
  });
});

import { describe, expect, it } from "vitest";
import { getToolPlan } from "../modules/agent/application/tool-plan.js";
import { parseAgentDecision } from "../modules/agent/application/agent-decision.js";

describe("tool execution boundary", () => {
  it("uses a stable execution id for retries", () => {
    const decision = parseAgentDecision(
      JSON.stringify({
        reply_text: "我先查一下。",
        next_action: "call_tool",
        tool: { name: "query_contact_profile", arguments: {} },
        requires_human: false,
        risk_level: "low",
      }),
    );
    expect(getToolPlan(decision, "turn-1")?.idempotencyKey).toBe(
      "agent-tool:turn-1",
    );
  });
});

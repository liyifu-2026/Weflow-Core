import { describe, expect, it } from "vitest";
import { agentActionToDecision } from "../modules/agent/application/agent-action-to-decision.js";

describe("agentActionToDecision", () => {
  it("maps a reply action", () => {
    const decision = agentActionToDecision({
      kind: "reply",
      segments: ["你好"],
    });
    expect(decision.nextAction).toBe("reply");
    expect(decision.replySegments).toEqual(["你好"]);
    expect(decision.replyText).toBe("你好");
    expect(decision.requiresHuman).toBe(false);
    expect(decision.riskLevel).toBe("low");
    expect(decision.noActionReason).toBeUndefined();
    expect(decision.tool).toBeUndefined();
    expect(decision.knowledgeQuery).toBeUndefined();
  });

  it("maps an ask action to ask_for_information", () => {
    const decision = agentActionToDecision({
      kind: "ask",
      segments: ["请提供型号。"],
      requestedFacts: ["device_model"],
    });
    expect(decision.nextAction).toBe("ask_for_information");
    expect(decision.replySegments).toEqual(["请提供型号。"]);
  });

  it("maps a use_tool action", () => {
    const decision = agentActionToDecision({
      kind: "use_tool",
      tool: "query_contact_profile",
      arguments: {},
    });
    expect(decision.nextAction).toBe("call_tool");
    expect(decision.tool).toEqual({
      name: "query_contact_profile",
      arguments: {},
    });
  });

  it("maps a handoff action with briefing and requiresHuman", () => {
    const decision = agentActionToDecision({
      kind: "handoff",
      reasonCode: "needs_human",
      briefing: {
        reasonCode: "needs_human",
        problemSummary: "summary",
        unresolvedItems: ["item-1"],
        suggestedFirstReply: "hello",
      },
    });
    expect(decision.nextAction).toBe("handoff");
    expect(decision.requiresHuman).toBe(true);
    expect(decision.handoffBriefing).toEqual({
      problemSummary: "summary",
      unresolvedItems: ["item-1"],
      suggestedFirstReply: "hello",
    });
  });

  it("maps a no_action action with its reason code", () => {
    const decision = agentActionToDecision({
      kind: "no_action",
      reasonCode: "waiting_for_user",
    });
    expect(decision.nextAction).toBe("no_action");
    expect(decision.noActionReason).toBe("waiting_for_user");
    expect(decision.replySegments).toEqual([]);
  });
});

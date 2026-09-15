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
    expect(decision.replySegments).toEqual([]);
  });

  it("maps a use_tool action carrying procedural note segments", () => {
    const decision = agentActionToDecision({
      kind: "use_tool",
      tool: "retrieve_knowledge",
      arguments: { query: "错误码 12535" },
      segments: ["稍等，我看下后台。"],
    });
    expect(decision.nextAction).toBe("call_tool");
    expect(decision.tool).toEqual({
      name: "retrieve_knowledge",
      arguments: { query: "错误码 12535" },
    });
    expect(decision.replySegments).toEqual(["稍等，我看下后台。"]);
    expect(decision.replyText).toBe("稍等，我看下后台。");
  });

  it("maps a handoff action with farewell segments", () => {
    const decision = agentActionToDecision({
      kind: "handoff",
      reasonCode: "needs_human",
      briefing: {
        reasonCode: "needs_human",
        problemSummary: "summary",
        unresolvedItems: [],
        suggestedFirstReply: "hello",
      },
      segments: ["这个我帮你转同事看一下，稍等。"],
    });
    expect(decision.nextAction).toBe("handoff");
    expect(decision.replySegments).toEqual(["这个我帮你转同事看一下，稍等。"]);
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

  it("maps a reply action carrying speak-and-wait parameters", () => {
    const decision = agentActionToDecision({
      kind: "reply",
      segments: ["先重启试试。"],
      waitMs: 90_000,
      nudgeText: "还在吗？",
    });
    expect(decision.nextAction).toBe("reply");
    expect(decision.replySegments).toEqual(["先重启试试。"]);
    expect(decision.waitMs).toBe(90_000);
    expect(decision.nudgeText).toBe("还在吗？");
  });

  it("maps a bare wait action", () => {
    const decision = agentActionToDecision({
      kind: "wait",
      waitMs: 120_000,
    });
    expect(decision.nextAction).toBe("wait");
    expect(decision.waitMs).toBe(120_000);
    expect(decision.nudgeText).toBeUndefined();
    expect(decision.replySegments).toEqual([]);
  });

  it("maps an end_session action with optional farewell segments", () => {
    const withFarewell = agentActionToDecision({
      kind: "end_session",
      closureSummary: "客户确认问题解决",
      segments: ["有问题再找我。"],
    });
    expect(withFarewell.nextAction).toBe("end_session");
    expect(withFarewell.closureSummary).toBe("客户确认问题解决");
    expect(withFarewell.replySegments).toEqual(["有问题再找我。"]);

    const silent = agentActionToDecision({
      kind: "end_session",
      closureSummary: "客户未再回复，超时收尾",
    });
    expect(silent.replySegments).toEqual([]);
    expect(silent.closureSummary).toBe("客户未再回复，超时收尾");
  });
});

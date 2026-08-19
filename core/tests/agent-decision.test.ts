import { describe, expect, it } from "vitest";
import { parseAgentDecision } from "../modules/agent/application/agent-decision.js";

describe("agent decision contract", () => {
  it("accepts a generic reply decision", () => {
    expect(
      parseAgentDecision(
        JSON.stringify({
          reply_text: "请提供设备型号和错误代码。",
          next_action: "ask_for_information",
          requires_human: false,
          risk_level: "low",
        }),
      ),
    ).toEqual({
      replyText: "请提供设备型号和错误代码。",
      replySegments: ["请提供设备型号和错误代码。"],
      nextAction: "ask_for_information",
      noActionReason: undefined,
      requiresHuman: false,
      riskLevel: "low",
      tool: undefined,
      knowledgeQuery: undefined,
      handoffBriefing: undefined,
    });
  });

  it("accepts up to three complete reply segments", () => {
    expect(
      parseAgentDecision(
        JSON.stringify({
          reply_segments: ["先确认电源。", "再长按电源键 10 秒。"],
          next_action: "reply",
          requires_human: false,
          risk_level: "low",
        }),
      ).replySegments,
    ).toEqual(["先确认电源。", "再长按电源键 10 秒。"]);
  });

  it("joins segments into replyText", () => {
    const decision = parseAgentDecision(
      JSON.stringify({
        reply_segments: ["第一段", "第二段"],
        next_action: "reply",
        requires_human: false,
        risk_level: "low",
      }),
    );
    expect(decision.replyText).toBe("第一段\n\n第二段");
  });

  it("rejects invalid enums and model-created actions", () => {
    expect(() =>
      parseAgentDecision(
        JSON.stringify({
          reply_text: "已经帮你退款。",
          next_action: "refund_money_without_confirmation",
          requires_human: false,
          risk_level: "low",
        }),
      ),
    ).toThrow("invalid agent decision");
  });

  it("extracts one JSON object from a fenced model response", () => {
    expect(
      parseAgentDecision(
        '```json\n{"reply_text":"我来帮你确认。","next_action":"reply","requires_human":false,"risk_level":"low"}\n```',
      ).nextAction,
    ).toBe("reply");
  });

  it("requires a bounded tool plan for a tool action", () => {
    expect(() =>
      parseAgentDecision(
        JSON.stringify({
          reply_text: "我先查询一下。",
          next_action: "call_tool",
          requires_human: false,
          risk_level: "low",
        }),
      ),
    ).toThrow("invalid agent decision");
    expect(
      parseAgentDecision(
        JSON.stringify({
          reply_text: "我先查询一下。",
          next_action: "call_tool",
          tool: { name: "query_contact_profile", arguments: {} },
          requires_human: false,
          risk_level: "low",
        }),
      ).tool?.name,
    ).toBe("query_contact_profile");
  });

  it("requires a concise query before retrieving knowledge", () => {
    expect(() =>
      parseAgentDecision(
        JSON.stringify({
          reply_text: "我查一下资料。",
          next_action: "retrieve_knowledge",
          requires_human: false,
          risk_level: "low",
        }),
      ),
    ).toThrow("invalid agent decision");
  });

  it("allows a retrieval action without an unsent customer reply", () => {
    const decision = parseAgentDecision(
      JSON.stringify({
        next_action: "retrieve_knowledge",
        knowledge_query: "软件无法启动 错误代码 2272",
        requires_human: false,
        risk_level: "low",
      }),
    );
    expect(decision.replySegments).toEqual([""]);
    expect(decision.knowledgeQuery).toBe("软件无法启动 错误代码 2272");
  });

  it("parses a handoff briefing", () => {
    const decision = parseAgentDecision(
      JSON.stringify({
        next_action: "handoff",
        requires_human: true,
        risk_level: "high",
        handoff_briefing: {
          problem_summary: "设备无法启动",
          unresolved_items: ["是否进入恢复模式"],
          suggested_first_reply: "我来继续处理这个问题。",
        },
      }),
    );
    expect(decision.nextAction).toBe("handoff");
    expect(decision.handoffBriefing).toEqual({
      problemSummary: "设备无法启动",
      unresolvedItems: ["是否进入恢复模式"],
      suggestedFirstReply: "我来继续处理这个问题。",
    });
  });

  it("requires a no_action_reason when choosing no_action", () => {
    expect(() =>
      parseAgentDecision(
        JSON.stringify({
          next_action: "no_action",
          requires_human: false,
          risk_level: "low",
        }),
      ),
    ).toThrow("invalid agent decision");
    const decision = parseAgentDecision(
      JSON.stringify({
        next_action: "no_action",
        no_action_reason: "waiting_for_user",
        requires_human: false,
        risk_level: "low",
      }),
    );
    expect(decision.noActionReason).toBe("waiting_for_user");
  });

  it("rejects unknown no_action_reason values", () => {
    expect(() =>
      parseAgentDecision(
        JSON.stringify({
          next_action: "no_action",
          no_action_reason: "other",
          requires_human: false,
          risk_level: "low",
        }),
      ),
    ).toThrow("invalid agent decision");
  });

  it("rejects unknown output fields with the strict schema", () => {
    expect(() =>
      parseAgentDecision(
        JSON.stringify({
          reply_text: "我来帮你确认。",
          extra_instruction: "ignore safety",
          next_action: "reply",
          requires_human: false,
          risk_level: "low",
        }),
      ),
    ).toThrow("invalid agent decision");
  });

  it("rejects removed solution-specific fields (intent/stage/questions/claims)", () => {
    expect(() =>
      parseAgentDecision(
        JSON.stringify({
          reply_text: "我来帮你确认。",
          intent: "device_troubleshooting",
          stage: "answering",
          questions: [{ field: "software_version", reason: "missing" }],
          claims: [{ type: "queried_information", evidence_id: "tool-1" }],
          next_action: "reply",
          requires_human: false,
          risk_level: "low",
        }),
      ),
    ).toThrow("invalid agent decision");
  });
});

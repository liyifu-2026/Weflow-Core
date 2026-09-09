import { describe, expect, it } from "vitest";
import { handoffBriefingViewModel } from "./handoff-briefing";

describe("handoff briefing presentation", () => {
  it("preserves Core wording without composing client-side handoff content", () => {
    const result = handoffBriefingViewModel({
      briefVersion: 2,
      problemSummary: "服务端问题摘要",
      confirmedFacts: [
        { key: "error_code", label: "服务端错误码标签", value: "2272" },
      ],
      missingInformation: [{ key: "device_serial", label: "服务端序列号标签" }],
      triedSteps: ["服务端已尝试步骤"],
      unresolvedItems: ["服务端未解决事项"],
      handoffReason: "服务端转人工原因",
      suggestedNextStep: "服务端建议下一步",
      suggestedFirstReply: "服务端建议首句",
      sourceConversationRevision: 4,
      generatedAt: "2026-08-04T01:00:00.000Z",
    });

    expect(result).toEqual({
      briefVersion: 2,
      headline: "服务端问题摘要",
      confirmedFacts: ["服务端错误码标签 · 2272"],
      triedSteps: ["服务端已尝试步骤"],
      missingInformation: ["服务端序列号标签"],
      unresolvedItems: ["服务端未解决事项"],
      handoffReason: "服务端转人工原因",
      suggestedNextStep: "服务端建议下一步",
      suggestedFirstReply: "服务端建议首句",
      sourceConversationRevision: 4,
    });
  });

  it("does not invent a briefing while Core has none", () => {
    expect(handoffBriefingViewModel(null)).toBeUndefined();
  });
});

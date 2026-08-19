import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAgentAction } from "../src/agent.js";

describe("isAgentAction", () => {
  it("accepts every supported action kind", () => {
    assert.equal(
      isAgentAction({ kind: "reply", segments: ["hello"] }),
      true,
    );
    assert.equal(
      isAgentAction({
        kind: "ask",
        segments: ["What is your device model?"],
        requestedFacts: ["device_model"],
      }),
      true,
    );
    assert.equal(
      isAgentAction({
        kind: "use_tool",
        tool: "query_contact_profile",
        arguments: {},
      }),
      true,
    );
    assert.equal(
      isAgentAction({
        kind: "handoff",
        reasonCode: "needs_human",
        briefing: {
          reasonCode: "needs_human",
          problemSummary: "summary",
          unresolvedItems: [],
          suggestedFirstReply: "I will connect you",
        },
      }),
      true,
    );
    assert.equal(
      isAgentAction({ kind: "no_action", reasonCode: "waiting_for_user" }),
      true,
    );
  });

  it("rejects unknown kinds", () => {
    assert.equal(isAgentAction({ kind: "fly" }), false);
  });

  it("rejects reply without segments", () => {
    assert.equal(isAgentAction({ kind: "reply" }), false);
  });

  it("rejects ask without requestedFacts", () => {
    assert.equal(
      isAgentAction({ kind: "ask", segments: ["hello"] }),
      false,
    );
  });
});

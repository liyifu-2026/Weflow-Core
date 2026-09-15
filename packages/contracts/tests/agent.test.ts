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
    assert.equal(
      isAgentAction({ kind: "wait", waitMs: 60_000 }),
      true,
    );
    assert.equal(
      isAgentAction({ kind: "end_session", closureSummary: "done" }),
      true,
    );
  });

  it("accepts speak-and-wait parameters on reply", () => {
    assert.equal(
      isAgentAction({
        kind: "reply",
        segments: ["hello"],
        waitMs: 90_000,
        nudgeText: "still there?",
      }),
      true,
    );
  });

  it("accepts optional procedural note segments on use_tool", () => {
    assert.equal(
      isAgentAction({
        kind: "use_tool",
        tool: "retrieve_knowledge",
        arguments: { query: "error 12535" },
        segments: ["稍等，我看下后台。"],
      }),
      true,
    );
    assert.equal(
      isAgentAction({
        kind: "use_tool",
        tool: "retrieve_knowledge",
        arguments: { query: "error 12535" },
        segments: [],
      }),
      true,
    );
    assert.equal(
      isAgentAction({
        kind: "use_tool",
        tool: "retrieve_knowledge",
        arguments: { query: "error 12535" },
        segments: ["ok", 42],
      }),
      false,
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

  it("rejects wait without numeric waitMs", () => {
    assert.equal(isAgentAction({ kind: "wait", waitMs: "soon" }), false);
  });

  it("rejects end_session without closureSummary", () => {
    assert.equal(isAgentAction({ kind: "end_session" }), false);
  });
});

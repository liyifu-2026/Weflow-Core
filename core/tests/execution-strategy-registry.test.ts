import { describe, expect, it } from "vitest";
import { MapExecutionStrategyRegistry } from "../modules/agent/contracts/execution-strategy.js";
import type { AgentExecutionStrategy } from "../modules/agent/contracts/execution-strategy.js";

const strategy: AgentExecutionStrategy = {
  id: "platform/structured-v1",
  version: "1.0.0",
  buildModelRequest: () => ({ system: "platform prompt", messages: [] }),
  parseModelResponse: () => ({ kind: "no_action", reasonCode: "test" }),
  validateAction: () => ({ ok: true }),
};

describe("ExecutionStrategyRegistry", () => {
  it("stores and retrieves strategies by id", () => {
    const registry = new MapExecutionStrategyRegistry([strategy]);
    expect(registry.has(strategy.id)).toBe(true);
    expect(registry.get(strategy.id)).toBe(strategy);
    expect(registry.list()).toHaveLength(1);
  });

  it("returns undefined for unknown strategies", () => {
    const registry = new MapExecutionStrategyRegistry();
    expect(registry.get("missing.strategy")).toBeUndefined();
  });

  it("supports dynamic register", () => {
    const registry = new MapExecutionStrategyRegistry();
    registry.register(strategy);
    expect(registry.get(strategy.id)).toBe(strategy);
  });

  it("conforms to the AgentExecutionStrategy contract", () => {
    const request = strategy.buildModelRequest({
      conversationId: "channel:conv-1",
      contactId: "contact:channel:contact-1",
      messages: [{ role: "user", content: "hi" }],
      facts: {},
      availableTools: ["retrieve_knowledge"],
    });
    expect(request.system).toBe("platform prompt");
    expect(request.messages).toEqual([]);

    const action = strategy.parseModelResponse({ text: "{}" });
    expect(action.kind).toBe("no_action");

    expect(
      strategy.validateAction({
        action,
        context: {
          conversationId: "channel:conv-1",
          contactId: "contact:channel:contact-1",
          messages: [],
          facts: {},
          availableTools: [],
        },
      }),
    ).toEqual({ ok: true });
  });
});

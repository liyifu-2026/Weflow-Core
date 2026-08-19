import { describe, expect, it } from "vitest";
import type { ChannelSendOperation } from "../modules/channel/contracts/channel-send-operations.js";
import { reconcileSendOperation } from "../modules/conversations/application/process-outbound-messages.js";

function operation(
  overrides: Partial<ChannelSendOperation> = {},
): ChannelSendOperation {
  return {
    operationId: "s2_op_1",
    conversationRef: "wxid_contact",
    payload: { kind: "text", text: "hello" },
    state: "confirmed",
    channelMessageId: "wx-msg-1",
    createdAt: "2026-08-17T00:00:01.000Z",
    updatedAt: "2026-08-17T00:00:02.000Z",
    ...overrides,
  };
}

describe("outbound send operation reconciliation", () => {
  it("reuses the same operation after a process reload", async () => {
    let persisted: ChannelSendOperation | undefined;
    let createCalls = 0;
    const client = {
      get: () => Promise.resolve(persisted),
      create: () => {
        createCalls += 1;
        const created = operation();
        persisted = created;
        return Promise.resolve(created);
      },
    };

    const first = await reconcileSendOperation(client, {
      operationId: "s2_op_1",
      conversationId: "wxid_contact",
      text: "hello",
      sendState: "pending",
    });
    const afterReload = await reconcileSendOperation(client, {
      operationId: "s2_op_1",
      conversationId: "wxid_contact",
      text: "hello",
      sendState: "submitting",
    });

    if (first.outcome !== "resolved" || afterReload.outcome !== "resolved") {
      throw new Error("send operation was not resolved");
    }
    expect(first.operation).toEqual(afterReload.operation);
    expect(createCalls).toBe(1);
  });

  it("keeps unknown unresolved instead of creating a replacement operation", async () => {
    let createCalls = 0;
    const result = await reconcileSendOperation(
      {
        get: () => Promise.resolve(undefined),
        create: () => {
          createCalls += 1;
          return Promise.resolve(operation({ state: "confirmed" }));
        },
      },
      {
        operationId: "s2_op_1",
        conversationId: "wxid_contact",
        text: "hello",
        sendState: "unknown",
      },
    );

    expect(result).toMatchObject({ outcome: "unknown" });
    if (result.outcome !== "unknown") {
      throw new Error("unknown operation was unexpectedly resolved");
    }
    expect(
      "operation" in result ? result.operation : undefined,
    ).toBeUndefined();
    expect(createCalls).toBe(0);
  });

  it("fails closed when an operation id is reused for different content", async () => {
    let createCalls = 0;
    const result = await reconcileSendOperation(
      {
        get: () => Promise.resolve(operation()),
        create: () => {
          createCalls += 1;
          return Promise.resolve(operation());
        },
      },
      {
        operationId: "s2_op_1",
        conversationId: "wxid_contact",
        text: "different",
        sendState: "submitting",
      },
    );

    expect(result).toMatchObject({
      outcome: "unknown",
      error: "send_operation_identity_conflict",
    });
    if (result.outcome !== "unknown") {
      throw new Error("conflicting operation was unexpectedly resolved");
    }
    expect(
      "operation" in result ? result.operation : undefined,
    ).toBeUndefined();
    expect(createCalls).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import type { ChannelSendOperation } from "../modules/channel/contracts/channel-send-operations.js";
import { queueJobIdForTurn } from "../infrastructure/redis/agent-turn-dispatcher.js";
import {
  operationIdForMessage,
  sendOperationMatches,
} from "../modules/conversations/application/process-outbound-messages.js";
import {
  memoryCaptureJobId,
  memoryCaptureRevision,
} from "../infrastructure/redis/memory-capture-dispatcher.js";

describe("external operation identifiers", () => {
  it("derives stable identifiers accepted by BullMQ and Channel Host", () => {
    const turnId = "turn:channel:conversation:server:42";
    const messageId = `agent-message:${turnId}`;

    expect(queueJobIdForTurn(turnId)).toMatch(/^agent_[a-f0-9]{64}$/);
    expect(queueJobIdForTurn(turnId)).toBe(queueJobIdForTurn(turnId));
    expect(operationIdForMessage(messageId)).toMatch(/^s2_[a-f0-9]{64}$/);
    expect(operationIdForMessage(messageId).length).toBeLessThanOrEqual(128);
    expect(memoryCaptureJobId("channel:contact", 4)).toMatch(
      /^memory_[a-f0-9]{64}$/,
    );
    expect(
      memoryCaptureRevision({
        jobId: "job",
        jobType: "memory.capture",
        ownerModule: "memory",
        businessEntityId: "channel:contact",
        idempotencyKey: `channel:contact\0${String(4)}`,
        attempt: 0,
        traceId: "trace",
        createdAt: new Date(0).toISOString(),
      }),
    ).toBe(4);
  });

  it("fails closed when a persisted Channel operation belongs to old content", () => {
    const operation: ChannelSendOperation = {
      operationId: "s2_existing",
      conversationRef: "wxid_contact",
      payload: { kind: "text", text: "old reply" },
      state: "confirmed" as const,
      channelMessageId: "server-42",
      createdAt: "2026-08-17T00:00:01.000Z",
      updatedAt: "2026-08-17T00:00:02.000Z",
    };
    expect(sendOperationMatches(operation, "wxid_contact", "old reply")).toBe(
      true,
    );
    expect(sendOperationMatches(operation, "wxid_contact", "new reply")).toBe(
      false,
    );
    expect(
      sendOperationMatches(operation, "another_contact", "old reply"),
    ).toBe(false);
  });
});

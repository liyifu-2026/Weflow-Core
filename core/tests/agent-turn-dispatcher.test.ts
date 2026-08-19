import { describe, expect, it } from "vitest";
import {
  AGENT_TURN_QUIET_WINDOW_MS,
  coalesceQueuedAgentTurns,
} from "../infrastructure/redis/agent-turn-dispatcher.js";

const now = new Date("2026-07-30T00:00:10.000Z");
const turn = (turnId: string, conversationId: string, ageMs: number) => ({
  turnId,
  conversationId,
  traceId: turnId,
  createdAt: new Date(now.getTime() - ageMs),
});

describe("agent turn quiet-window coalescing", () => {
  it("keeps only the newest quiet turn and supersedes earlier turns", () => {
    const result = coalesceQueuedAgentTurns(
      [
        turn("turn-a", "conversation-a", 5_000),
        turn("turn-b", "conversation-a", 4_000),
      ],
      now,
    );

    expect(result.ready.map(({ turnId }) => turnId)).toEqual(["turn-b"]);
    expect(result.superseded.map(({ turnId }) => turnId)).toEqual(["turn-a"]);
  });

  it("waits until the newest message has been quiet for three seconds", () => {
    const result = coalesceQueuedAgentTurns(
      [turn("turn-a", "conversation-a", AGENT_TURN_QUIET_WINDOW_MS - 1)],
      now,
    );

    expect(result.ready).toEqual([]);
    expect(result.superseded).toEqual([]);
  });

  it("coalesces each conversation independently", () => {
    const result = coalesceQueuedAgentTurns(
      [
        turn("turn-a", "conversation-a", 3_000),
        turn("turn-b", "conversation-b", 3_000),
      ],
      now,
    );

    expect(result.ready.map(({ turnId }) => turnId)).toEqual([
      "turn-a",
      "turn-b",
    ]);
  });

  it("keeps the final turn for a three-message burst", () => {
    const result = coalesceQueuedAgentTurns(
      [
        turn("turn-a", "conversation-a", 5_000),
        turn("turn-b", "conversation-a", 4_000),
        turn("turn-c", "conversation-a", 3_000),
      ],
      now,
    );

    expect(result.ready.map(({ turnId }) => turnId)).toEqual(["turn-c"]);
    expect(result.superseded.map(({ turnId }) => turnId)).toEqual([
      "turn-a",
      "turn-b",
    ]);
  });
});

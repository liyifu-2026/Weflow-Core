import { describe, expect, it } from "vitest";
import {
  AGENT_PENDING_REPLY_WINDOW_MS,
  AGENT_TURN_QUIET_WINDOW_MS,
  STALE_RUNNING_TURN_MS,
  coalesceQueuedAgentTurns,
  pendingReplyWindowStart,
  staleRunningTurnBefore,
} from "../modules/conversations/application/agent-turn-scheduling-policy.js";

const now = new Date("2026-07-30T00:00:10.000Z");
const turn = (turnId: string, conversationId: string, ageMs: number) => ({
  turnId,
  conversationId,
  traceId: turnId,
  createdAt: new Date(now.getTime() - ageMs),
});

describe("agent turn scheduling policy", () => {
  it("pins the moved policy constants", () => {
    expect(AGENT_TURN_QUIET_WINDOW_MS).toBe(3_000);
    expect(AGENT_PENDING_REPLY_WINDOW_MS).toBe(10 * 60_000);
    expect(STALE_RUNNING_TURN_MS).toBe(5 * 60_000);
  });

  it("does not release a turn inside the quiet window", () => {
    const result = coalesceQueuedAgentTurns(
      [turn("turn-a", "conversation-a", AGENT_TURN_QUIET_WINDOW_MS - 1)],
      now,
    );

    expect(result.ready).toEqual([]);
    expect(result.superseded).toEqual([]);
  });

  it("releases a turn exactly at the quiet window boundary", () => {
    const result = coalesceQueuedAgentTurns(
      [turn("turn-a", "conversation-a", AGENT_TURN_QUIET_WINDOW_MS)],
      now,
    );

    expect(result.ready.map(({ turnId }) => turnId)).toEqual(["turn-a"]);
    expect(result.superseded).toEqual([]);
  });

  it("keeps only the newest turn outside the quiet window and supersedes older ones", () => {
    const result = coalesceQueuedAgentTurns(
      [
        turn("turn-a", "conversation-a", AGENT_TURN_QUIET_WINDOW_MS + 4_000),
        turn("turn-b", "conversation-a", AGENT_TURN_QUIET_WINDOW_MS),
      ],
      now,
    );

    expect(result.ready.map(({ turnId }) => turnId)).toEqual(["turn-b"]);
    expect(result.superseded.map(({ turnId }) => turnId)).toEqual(["turn-a"]);
  });

  it("computes the pending-reply exclusion window start", () => {
    expect(pendingReplyWindowStart(now).getTime()).toBe(
      now.getTime() - AGENT_PENDING_REPLY_WINDOW_MS,
    );
  });

  it("computes the stale running turn cutoff", () => {
    expect(staleRunningTurnBefore(now).getTime()).toBe(
      now.getTime() - STALE_RUNNING_TURN_MS,
    );
  });
});

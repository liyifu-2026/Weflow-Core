import { describe, expect, it } from "vitest";
import {
  AGENT_PENDING_REPLY_WINDOW_MS,
  AGENT_TURN_QUIET_WINDOW_MS,
  STALE_RUNNING_TURN_MS,
  coalesceQueuedAgentTurns,
  pendingReplyWindowStart,
  staleRunningTurnBefore,
  staleRunningTurnThresholdMs,
} from "../modules/conversations/application/agent-turn-scheduling-policy.js";

const now = new Date("2026-07-30T00:00:10.000Z");
const turn = (
  turnId: string,
  conversationId: string,
  ageMs: number,
  triggerOccurredAt?: Date | null,
) => ({
  turnId,
  conversationId,
  traceId: turnId,
  createdAt: new Date(now.getTime() - ageMs),
  ...(triggerOccurredAt === undefined ? {} : { triggerOccurredAt }),
});

describe("agent turn scheduling policy", () => {
  it("pins the moved policy constants", () => {
    expect(AGENT_TURN_QUIET_WINDOW_MS).toBe(1_500);
    expect(AGENT_PENDING_REPLY_WINDOW_MS).toBe(10 * 60_000);
    // 90s 旧值小于 180s 决策超时，会误回收在飞的长思考决策（审计 C1）；
    // 兜底常量提到 300s，dispatcher 按决策超时推导真实阈值。
    expect(STALE_RUNNING_TURN_MS).toBe(300 * 1_000);
  });

  it("derives the stale threshold above the decision timeout", () => {
    // 180s 决策超时 → 阈值 = 2×180s + 60s（覆盖截断重试两次调用）；
    // 下限 300s 防配置出超短超时把阈值拉得过小。
    expect(staleRunningTurnThresholdMs(180_000)).toBe(420_000);
    expect(staleRunningTurnThresholdMs(30_000)).toBe(300_000);
    expect(staleRunningTurnBefore(new Date(1_000_000), 420_000).getTime()).toBe(
      1_000_000 - 420_000,
    );
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

  it("ranks by trigger message time, not turn row creation time (out-of-order ingestion)", () => {
    // 2026-09-06 Leaif 事故形状：文字消息先到、图片后到，但图片的 turn 行
    // 先落库（createdAt 更早）。旧排序按行创建时间会留下文字 turn——它恰被
    // worker 的 superseded 闸门按消息时间处决，双双 superseded、客户收不到回复。
    const result = coalesceQueuedAgentTurns(
      [
        // 文字 turn：触发消息更早（14:21:36），turn 行后落库（ageMs 更小）
        turn(
          "turn:text",
          "conversation-a",
          AGENT_TURN_QUIET_WINDOW_MS,
          new Date("2026-09-06T14:21:36.000Z"),
        ),
        // 图片 turn：触发消息更晚（14:21:42），turn 行先落库（ageMs 更大）
        turn(
          "turn:image",
          "conversation-a",
          AGENT_TURN_QUIET_WINDOW_MS + 2_000,
          new Date("2026-09-06T14:21:42.000Z"),
        ),
      ],
      now,
    );

    expect(result.ready.map(({ turnId }) => turnId)).toEqual(["turn:image"]);
    expect(result.superseded.map(({ turnId }) => turnId)).toEqual([
      "turn:text",
    ]);
  });

  it("wake turns (no trigger message) yield to message turns in the same window", () => {
    const result = coalesceQueuedAgentTurns(
      [
        turn("turn:wake:1", "conversation-a", AGENT_TURN_QUIET_WINDOW_MS, null),
        turn(
          "turn:msg",
          "conversation-a",
          AGENT_TURN_QUIET_WINDOW_MS,
          new Date("2026-09-06T14:21:42.000Z"),
        ),
      ],
      now,
    );

    expect(result.ready.map(({ turnId }) => turnId)).toEqual(["turn:msg"]);
    expect(result.superseded.map(({ turnId }) => turnId)).toEqual([
      "turn:wake:1",
    ]);
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

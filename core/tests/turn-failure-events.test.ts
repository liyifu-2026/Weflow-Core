/**
 * 失败事件落库单测：
 * - reconcileAgentTurnQueueFailure 必须把 turn_failed 事件随 commitAgentTurnFailure
 *   一并提交（排错统一从 turn_events 查，不依赖 stdout 文本日志）。
 * - turn 无法定位时不提交任何失败（既有语义）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

type FailureInput = {
  errorCode: string;
  handoffReason?: string;
  events?: Array<{
    eventType: string;
    reasonCode?: string;
    payload?: Record<string, unknown>;
  }>;
};

const commitAgentTurnFailure = vi.hoisted(() =>
  vi.fn<(db: unknown, input: FailureInput) => Promise<void>>(),
);

vi.mock("../modules/agent/application/agent-turn-outcome-command.js", () => ({
  commitAgentTurnFailure,
}));

import { reconcileAgentTurnQueueFailure } from "../modules/agent/application/agent-turn-failure-coordinator.js";

type Selector = { conversationId?: string };

function fakeDb(rows: Selector[]) {
  return {
    // 协调器有三类查询（turn 定位 / 最后 turn_error / 最后客户入站）。
    // 空结果集让 turn 定位之外的查询全部落空——断言只关心
    // commitAgentTurnFailure 的入参形态。支持 where→limit 与 where→orderBy→limit。
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
        orderBy: () => ({
          limit: () => Promise.resolve([]),
        }),
        limit: () => Promise.resolve(rows),
      }),
    }),
  } as never;
}

describe("reconcileAgentTurnQueueFailure — turn_failed 事件", () => {
  beforeEach(() => {
    commitAgentTurnFailure.mockClear();
  });

  it("重试耗尽时提交 turn_failed 事件（含 errorCode 与 handoffReason）", async () => {
    await reconcileAgentTurnQueueFailure(
      fakeDb([{ conversationId: "conv:1" }]),
      "turn:1",
      "retry_exhausted",
    );

    expect(commitAgentTurnFailure).toHaveBeenCalledTimes(1);
    const input = commitAgentTurnFailure.mock.calls[0]?.[1];
    expect(input?.errorCode).toBe("retry_exhausted");
    expect(input?.handoffReason).toBe("model_unavailable: retry_exhausted");
    expect(input?.events).toHaveLength(1);
    expect(input?.events?.[0]?.eventType).toBe("turn_failed");
    expect(input?.events?.[0]?.reasonCode).toBe("retry_exhausted");
    expect(input?.events?.[0]?.payload?.handoffReason).toBe(
      "model_unavailable: retry_exhausted",
    );
  });

  it("turn 不存在时不触发失败提交", async () => {
    await reconcileAgentTurnQueueFailure(
      fakeDb([]),
      "turn:none",
      "retry_exhausted",
    );
    expect(commitAgentTurnFailure).not.toHaveBeenCalled();
  });
});

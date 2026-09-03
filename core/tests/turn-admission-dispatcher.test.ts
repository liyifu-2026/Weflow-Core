import { describe, expect, it, vi } from "vitest";

import { startTurnAdmissionDispatcher } from "../modules/conversations/application/start-turn-admission-dispatcher.js";

describe("startTurnAdmissionDispatcher", () => {
  it("按轮询间隔反复调用处理器，abort 后停止", async () => {
    vi.useFakeTimers();
    const process = vi.fn(async () => 0);
    const stop = startTurnAdmissionDispatcher({
      process,
      intervalMs: 50,
    });
    // 首轮立即执行
    await vi.advanceTimersByTimeAsync(1);
    expect(process).toHaveBeenCalledTimes(1);
    // 一个周期后再执行
    await vi.advanceTimersByTimeAsync(60);
    expect(process).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(process).toHaveBeenCalledTimes(2); // 不再增长
    vi.useRealTimers();
  });

  it("处理器抛错不中断循环（记录后继续）", async () => {
    vi.useFakeTimers();
    const process = vi
      .fn<(context: { signal: AbortSignal }) => Promise<number>>()
      .mockRejectedValueOnce(new Error("db hiccup"))
      .mockResolvedValue(0);
    const stop = startTurnAdmissionDispatcher({
      process,
      intervalMs: 50,
    });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(process).toHaveBeenCalledTimes(2);
    stop();
    vi.useRealTimers();
  });
});

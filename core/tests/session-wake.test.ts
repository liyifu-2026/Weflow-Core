import { describe, expect, it, vi } from "vitest";

import {
  scheduleSessionWake,
} from "../modules/agent/application/session-wake.js";

describe("scheduleSessionWake（wait 决策落唤醒行）", () => {
  const base = new Date("2026-01-01T00:00:00Z");

  function makeDb() {
    const db = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    return db;
  }

  it("wait 决策：登记 wake（wakeAt=now+wait_ms）+ 预承诺 nudge 文本", async () => {
    const db = makeDb();
    await scheduleSessionWake(db as never, {
      conversationId: "conv:1",
      turnId: "turn:1",
      waitMs: 300_000,
      nudgeText: "您先忙，有问题随时叫我",
      now: base,
    });
    const row = db.values.mock.calls[0]![0];
    expect(row.conversationId).toBe("conv:1");
    expect(row.turnId).toBe("turn:1");
    expect(row.status).toBe("scheduled");
    expect(row.wakeAt.getTime()).toBe(base.getTime() + 300_000);
    expect(row.nudgeText).toBe("您先忙，有问题随时叫我");
    expect(row.kind).toBe("wait_timeout");
  });

  it("不带 nudge 的 wait：nudge_text 为空，超时只收尾不发消息", async () => {
    const db = makeDb();
    await scheduleSessionWake(db as never, {
      conversationId: "conv:1",
      turnId: "turn:1",
      waitMs: 60_000,
      now: base,
    });
    const row = db.values.mock.calls[0]![0];
    expect(row.nudgeText).toBeNull();
  });
});

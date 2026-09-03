/**
 * Phase 3：会话唤醒消费 dispatcher 单元测试。
 *
 * 到期 wake 的两种去向：
 * - 带 nudge_text → createAgentReply 直发预承诺话术（不开模型）；
 * - 无 nudge_text → 建一个 scheduled Agent Turn（唤醒续轮，模型判断）。
 * 消费后一律 mark done；建 turn 失败不阻断标记（消息不重复发）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../modules/agent/application/agent-turn-outcome-command.js", () => ({
  commitAgentTurnFailure: vi.fn(async () => undefined),
  commitAgentTurnHandoff: vi.fn(async () => ({ status: "committed" })),
  commitAgentTurnNoAction: vi.fn(async () => ({ status: "committed" })),
  commitAgentTurnOutcome: vi.fn(async () => ({ status: "committed" })),
  commitAgentTurnSuperseded: vi.fn(async () => undefined),
  persistAgentToolCheckpoint: vi.fn(async () => ({ status: "planned" })),
}));



function makeDb() {
  const wakes = [
    {
      wakeId: 1,
      conversationId: "conv:1",
      turnId: "turn:1",
      kind: "wait_timeout",
      status: "scheduled",
      wakeAt: new Date(Date.now() - 1000),
      nudgeText: "您先忙，有问题随时叫我",
    },
    {
      wakeId: 2,
      conversationId: "conv:2",
      turnId: "turn:2",
      kind: "wait_timeout",
      status: "scheduled",
      wakeAt: new Date(Date.now() - 1000),
      nudgeText: null,
    },
  ];
  const insertedTurns: unknown[] = [];
  const insertedMessages: { segments?: string[] }[] = [];
  const updated = { wakeIds: [] as number[] };
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => {
      const p = Promise.resolve(wakes);
      return Object.assign(p, { limit: () => Promise.resolve(wakes) });
    }),
    limit: vi.fn().mockResolvedValue(wakes),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn((row: unknown) => {
      const r = row as { turnId?: string };
      if (r?.turnId) insertedTurns.push(r);
      else insertedMessages.push(row as { segments?: string[] });
      return db;
    }),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    eq: vi.fn(),
  };
  return { db, wakes, insertedTurns, insertedMessages, updated };
}

vi.mock("../modules/conversations/application/message-service.js", () => ({
  createAgentReply: vi.fn(async () => ({ created: true })),
}));

describe("processDueSessionWakes", () => {
  it("带 nudge 的到期 wake 走 createAgentReply 直发，无 nudge 的建续轮 turn", async () => {
    const { processDueSessionWakes: realProcess } = await import(
      "../modules/agent/application/process-session-wakes.js"
    );
    const { createAgentReply } = await import(
      "../modules/conversations/application/message-service.js"
    );
    const deps = makeDb();
    vi.mocked(createAgentReply).mockClear();

    const processed = await realProcess(
      deps.db as never,
      {
        checkGates: async () => ({ blocked: false, reason: "handoff_active" }),
      } as never,
    );

    expect(processed).toBe(2);
    expect(createAgentReply).toHaveBeenCalledTimes(1);
    expect(createAgentReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: "conv:1",
        segments: ["您先忙，有问题随时叫我"],
      }),
    );
    expect(deps.insertedTurns).toHaveLength(1);
    expect(deps.insertedTurns[0]).toMatchObject({
      conversationId: "conv:2",
      status: "queued",
    });
  });
});


describe("processDueSessionWakes 策略闸门", () => {
  it("Handoff 接管后到期的 wake 静默作废：不直发、不建轮，直接 done", async () => {
    const { processDueSessionWakes } = await import(
      "../modules/agent/application/process-session-wakes.js"
    );
    const { createAgentReply } = await import(
      "../modules/conversations/application/message-service.js"
    );
    vi.mocked(createAgentReply).mockClear();
    // makeDb 复用：闸门判定注入——isAgentPaused 返回 true
    const gateDeps = {
      checkGates: async () => ({
        blocked: true,
        reason: "handoff_active" as const,
      }),
    };
    const wakes = [
      {
        wakeId: 9,
        conversationId: "conv:gated",
        turnId: "turn:gated",
        kind: "wait_timeout",
        status: "scheduled",
        wakeAt: new Date(Date.now() - 1000),
        nudgeText: "您先忙",
      },
    ];
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        const p = Promise.resolve(wakes);
        return Object.assign(p, { limit: () => Promise.resolve(wakes) });
      }),
      limit: vi.fn().mockResolvedValue(wakes),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };
    const processed = await processDueSessionWakes(
      db as never,
      gateDeps as never,
    );
    expect(processed).toBe(0);
    expect(createAgentReply).not.toHaveBeenCalled();
    // 静默作废：置 done
    expect(db.set).toHaveBeenCalledWith({ status: "done" });
  });
});

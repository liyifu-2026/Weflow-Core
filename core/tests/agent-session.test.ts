import { describe, expect, it } from "vitest";

import {
  DEFAULT_SESSION_TTL_MS,
  MAX_ROUNDS_PER_SESSION,
  decideSessionTransition,
  type SessionStateSnapshot,
} from "../modules/agent/application/agent-session.js";

describe("decideSessionTransition", () => {
  const base: SessionStateSnapshot = {
    state: "active",
    roundsUsed: 5,
    roundBudget: MAX_ROUNDS_PER_SESSION,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    now: new Date("2026-01-01T00:10:00Z"),
    agentPaused: false,
    agentEnabled: true,
  };

  it("active + 预算内 + TTL 内 → 继续会话", () => {
    const t = decideSessionTransition(base);
    expect(t).toEqual({ action: "continue" });
  });

  it("TTL 到期 → 强制收尾（end_session，代码持有）", () => {
    const t = decideSessionTransition({
      ...base,
      now: new Date("2026-01-01T01:00:00Z"),
    });
    expect(t).toEqual({
      action: "force_close",
      reason: "session_ttl_exceeded",
    });
  });

  it("轮数预算耗尽 → 强制收尾", () => {
    const t = decideSessionTransition({
      ...base,
      roundsUsed: MAX_ROUNDS_PER_SESSION,
    });
    expect(t).toEqual({
      action: "force_close",
      reason: "round_budget_exhausted",
    });
  });

  it("Handoff 暂停 → 冻结（每轮开头复检，不只入会话时）", () => {
    const t = decideSessionTransition({ ...base, agentPaused: true });
    expect(t).toEqual({ action: "freeze", reason: "handoff_active" });
  });

  it("联系人摘除白名单 → 冻结", () => {
    const t = decideSessionTransition({ ...base, agentEnabled: false });
    expect(t).toEqual({ action: "freeze", reason: "agent_disabled" });
  });

  it("waiting 状态在预算内 → 等待唤醒", () => {
    const t = decideSessionTransition({ ...base, state: "waiting" });
    expect(t).toEqual({ action: "continue" });
  });

  it("closed 状态 → 不再处理", () => {
    const t = decideSessionTransition({ ...base, state: "closed" });
    expect(t).toEqual({ action: "freeze", reason: "session_closed" });
  });

  it("TTL 缺省值为 45 分钟", () => {
    expect(DEFAULT_SESSION_TTL_MS).toBe(45 * 60_000);
  });
});

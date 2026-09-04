/**
 * 定时发送（SCHEDULED-SEND-PLAN）单测：
 * - dispatcher 到点执行：直发 / handoff 冻结 / 白名单摘除作废 / 静音顺延
 * - 预承诺内容的 zod 契约（parseAgentDecision）
 * - 静音时段顺延的纯函数
 * 到点直发不调用模型（预承诺直发家法）——fire 由依赖注入，测试断言其被调用。
 */
import { describe, expect, it, vi } from "vitest";
import {
  processDueScheduledSends,
  shiftOutOfQuietHours,
} from "../modules/agent/application/scheduled-sends.js";
import { parseAgentDecision } from "../modules/agent/application/agent-decision.js";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    scheduledSendId: "scheduled:turn-1",
    conversationId: "wechat:wxid_demo",
    turnId: "turn-1",
    content: "明早 9 点提醒您续费",
    status: "pending",
    sendAt: new Date("2026-09-06T01:00:00.000Z"),
    firedMessageId: null,
    cancelReason: null,
    createdAt: new Date("2026-09-05T00:00:00.000Z"),
    updatedAt: new Date("2026-09-05T00:00:00.000Z"),
    ...overrides,
  };
}

function makeDb(due: ReturnType<typeof dueRow>[]) {
  const setCalls: Array<{ patch: Record<string, unknown> }> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(due),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        setCalls.push({ patch });
        const chain: any = {};
        chain.where = () => chain;
        chain.returning = () => Promise.resolve([]);
        chain.then = (resolve: (v: unknown) => void) => resolve(undefined);
        return chain;
      },
    }),
    __setCalls: setCalls,
  };
  return { db: db as never, setCalls };
}

describe("processDueScheduledSends", () => {
  it("到点直发：预承诺内容经注入的 fire 发出，状态置 fired 并记录 messageId", async () => {
    const row = dueRow();
    const { db, setCalls } = makeDb([row]);
    const fire = vi.fn(async (_db, input) => ({
      messageId: `agent-message:${input.scheduledSendId}:fire:1`,
    }));

    const actioned = await processDueScheduledSends(
      db,
      {
        fire,
        checkGates: vi.fn(async () => ({
          blocked: false,
          reason: "handoff_active" as const,
        })),
        quietStartHour: 22,
        quietEndHour: 8,
      },
      undefined,
      new Date("2026-09-06T01:00:05.000Z"),
    );

    expect(actioned).toBe(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        conversationId: row.conversationId,
        scheduledSendId: row.scheduledSendId,
        content: row.content,
      }),
    );
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]!.patch).toMatchObject({
      status: "fired",
      firedMessageId: "agent-message:scheduled:turn-1:fire:1",
    });
  });

  it("handoff 接管：到点不直发，状态置 frozen 进待审（决策 #6）", async () => {
    const { db, setCalls } = makeDb([dueRow()]);
    const fire = vi.fn(async () => ({ messageId: null }));

    await processDueScheduledSends(
      db,
      {
        fire,
        checkGates: vi.fn(async () => ({
          blocked: true,
          reason: "handoff_active" as const,
        })),
      },
      undefined,
      new Date("2026-09-06T01:00:05.000Z"),
    );

    expect(fire).not.toHaveBeenCalled();
    expect(setCalls[0]!.patch).toMatchObject({ status: "frozen" });
  });

  it("白名单摘除：到点作废（cancelled/agent_disabled）", async () => {
    const { db, setCalls } = makeDb([dueRow()]);
    const fire = vi.fn(async () => ({ messageId: null }));

    await processDueScheduledSends(
      db,
      {
        fire,
        checkGates: vi.fn(async () => ({
          blocked: true,
          reason: "agent_disabled" as const,
        })),
      },
      undefined,
      new Date("2026-09-06T01:00:05.000Z"),
    );

    expect(fire).not.toHaveBeenCalled();
    expect(setCalls[0]!.patch).toMatchObject({
      status: "cancelled",
      cancelReason: "agent_disabled",
    });
  });

  it("静音时段：落点 23:30 顺延到次日 08:00，不直发", async () => {
    const sendAt = new Date();
    sendAt.setHours(23, 30, 0, 0);
    const { db, setCalls } = makeDb([dueRow({ sendAt })]);
    const fire = vi.fn(async () => ({ messageId: null }));

    await processDueScheduledSends(
      db,
      {
        fire,
        checkGates: vi.fn(async () => ({
          blocked: false,
          reason: "handoff_active" as const,
        })),
        quietStartHour: 22,
        quietEndHour: 8,
      },
      undefined,
      new Date(),
    );

    expect(fire).not.toHaveBeenCalled();
    const shifted = setCalls[0]!.patch.sendAt as Date;
    expect(shifted.getDate()).toBe(sendAt.getDate() + 1);
    expect(shifted.getHours()).toBe(8);
    expect(shifted.getMinutes()).toBe(0);
  });
});

describe("shiftOutOfQuietHours", () => {
  it("跨零点窗口：23:30 顺延到次日 08:00", () => {
    const d = new Date();
    d.setHours(23, 30, 0, 0);
    const expected = new Date(d);
    expected.setDate(d.getDate() + 1);
    expected.setHours(8, 0, 0, 0);
    expect(shiftOutOfQuietHours(d, 22, 8)).toEqual(expected);
  });

  it("跨零点窗口：凌晨 02:00 顺延到当日 08:00", () => {
    const d = new Date();
    d.setHours(2, 15, 0, 0);
    const shifted = shiftOutOfQuietHours(d, 22, 8);
    expect(shifted.getHours()).toBe(8);
    expect(shifted.getDate()).toBe(d.getDate());
  });

  it("窗口外：12:00 原样返回", () => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    expect(shiftOutOfQuietHours(d, 22, 8)).toEqual(d);
  });

  it("起止相等：视为关闭静音，原样返回", () => {
    const d = new Date();
    d.setHours(23, 0, 0, 0);
    expect(shiftOutOfQuietHours(d, 22, 22)).toEqual(d);
  });
});

describe("parseAgentDecision — schedule_send 契约", () => {
  it("合法 schedule_send：解析出内容与到点时间", () => {
    const decision = parseAgentDecision(
      JSON.stringify({
        next_action: "schedule_send",
        requires_human: false,
        risk_level: "low",
        scheduled_message: "明早 9 点提醒您续费",
        scheduled_send_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
    );
    expect(decision.nextAction).toBe("schedule_send");
    expect(decision.scheduledMessage).toBe("明早 9 点提醒您续费");
    expect(decision.scheduledSendAt).toBeInstanceOf(Date);
  });

  it("缺 scheduled_message：拒绝", () => {
    expect(() =>
      parseAgentDecision(
        JSON.stringify({
          next_action: "schedule_send",
          requires_human: false,
          risk_level: "low",
          scheduled_send_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
      ),
    ).toThrow();
  });

  it("到点超出 30 天：拒绝", () => {
    expect(() =>
      parseAgentDecision(
        JSON.stringify({
          next_action: "schedule_send",
          requires_human: false,
          risk_level: "low",
          scheduled_message: "太远了",
          scheduled_send_at: new Date(Date.now() + 31 * 24 * 60 * 60_000).toISOString(),
        }),
      ),
    ).toThrow();
  });
});

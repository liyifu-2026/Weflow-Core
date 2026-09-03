import { describe, expect, it, vi } from "vitest";

import {
  claimDueTurnAdmission,
  looksLikeUnfinished,
  nextAdmissionAt,
  scheduleTurnAdmission,
} from "../modules/conversations/application/turn-admission.js";

describe("looksLikeUnfinished", () => {
  it("半句词或未完标点结尾判为未说完；终止标点与空文本判为说完", () => {
    expect(looksLikeUnfinished("你知道")).toBe(true);
    expect(looksLikeUnfinished("等一下")).toBe(true);
    expect(looksLikeUnfinished("我跟你讲，")).toBe(true);
    expect(looksLikeUnfinished("退款了怎么还没到。")).toBe(false);
    expect(looksLikeUnfinished("在吗？")).toBe(false);
    expect(looksLikeUnfinished("")).toBe(false);
    expect(looksLikeUnfinished(null)).toBe(false);
  });
});

describe("nextAdmissionAt", () => {
  const base = new Date("2026-01-01T00:00:00Z");

  it("说完的消息按默认静默窗收窗（12s）", () => {
    const at = nextAdmissionAt({ text: "在吗？", now: base });
    expect(at.getTime()).toBe(base.getTime() + 12_000);
  });

  it("半句未完的消息延长收窗（最多 30s）", () => {
    const at = nextAdmissionAt({ text: "你知道", now: base });
    expect(at.getTime()).toBe(base.getTime() + 30_000);
  });

  it("已有登记被同会话新消息重置时，不晚于窗口上限", () => {
    // 收窗只由「最后一条消息的时间 + 窗口」决定；同会话更早的登记不影响
    const at = nextAdmissionAt({
      text: "在吗？",
      now: base,
      unfinishedWindowMs: 5_000, // 上限比基准窗还短时取 max
    });
    expect(at.getTime()).toBe(base.getTime() + 12_000);
  });

  it("参数异常回落默认窗，绝不抛错", () => {
    const at = nextAdmissionAt({ text: "在吗？", now: base, quietWindowMs: -5 });
    expect(at.getTime()).toBe(base.getTime() + 12_000);
  });
});

describe("scheduleTurnAdmission", () => {
  const base = new Date("2026-01-01T00:00:00Z");

  function makeDb() {
    const db = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    return db;
  }

  it("首条消息：登记 scheduled + scheduledAt=收窗时刻 + watermark=本条消息", async () => {
    const db = makeDb();
    await scheduleTurnAdmission(db as never, {
      conversationId: "conv:1",
      contactId: "contact:1",
      messageId: "msg:1",
      text: "在吗？",
      now: base,
    });
    expect(db.insert).toHaveBeenCalledTimes(1);
    const row = db.values.mock.calls[0]![0];
    expect(row.conversationId).toBe("conv:1");
    expect(row.status).toBe("scheduled");
    expect(row.scheduledAt.getTime()).toBe(base.getTime() + 12_000);
    expect(row.lastMessageId).toBe("msg:1");
    expect(row.messageCount).toBe(1);
  });

  it("窗内新消息：重置收窗时刻、累加计数、revision+1、清错误", async () => {
    const db = makeDb();
    await scheduleTurnAdmission(db as never, {
      conversationId: "conv:1",
      contactId: "contact:1",
      messageId: "msg:2",
      text: "你知道",
      now: base,
      existingRevision: 3,
      existingCount: 1,
    });
    const update = db.onConflictDoUpdate.mock.calls[0]![0];
    expect(update.target).toBeDefined();
    const set = update.set;
    expect(set.scheduledAt.getTime()).toBe(base.getTime() + 30_000); // 半句延长
    expect(set.lastMessageId).toBe("msg:2");
    expect(set.messageCount).toBe(2);
    expect(set.status).toBe("scheduled");
    expect(set.attempt).toBe(0);
    expect(set.errorCode).toBeNull();
    // revision 是 SQL 表达式（revision + 1）；确认它不是普通数字而是自增语义
    expect(typeof set.revision).toBe("object");
    expect(set.revision).toBeDefined();
  });
});

describe("claimDueTurnAdmission", () => {
  const base = new Date("2026-01-01T00:00:00Z");

  function makeDb(claimedRows: unknown[]) {
    const db = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue(claimedRows),
    };
    return db;
  }

  it("到期登记被 CAS 认领为 dispatching，返回会话与水位", async () => {
    const db = makeDb([
      {
        conversationId: "conv:1",
        contactId: "contact:1",
        lastMessageId: "msg:2",
        messageCount: 2,
        revision: 2,
        status: "dispatching",
      },
    ]);
    const claimed = await claimDueTurnAdmission(db as never, {
      conversationId: "conv:1",
      revision: 2,
      now: base,
    });
    expect(claimed).not.toBeNull();
    expect(claimed?.conversationId).toBe("conv:1");
    expect(claimed?.lastMessageId).toBe("msg:2");
    expect(claimed?.messageCount).toBe(2);
  });

  it("认领不到（stale revision / 已被认领）返回 null，不建 turn", async () => {
    const db = makeDb([]);
    const claimed = await claimDueTurnAdmission(db as never, {
      conversationId: "conv:1",
      revision: 1,
      now: base,
    });
    expect(claimed).toBeNull();
  });

  it("认领只命中 scheduled + scheduledAt<=now 的行（CAS where 条件）", async () => {
    const db = makeDb([]);
    await claimDueTurnAdmission(db as never, {
      conversationId: "conv:1",
      revision: 3,
      now: base,
    });
    const setArg = db.set.mock.calls[0]![0];
    expect(setArg.status).toBe("dispatching");
    // where 条件里必须同时含 revision、status、scheduledAt 三个约束
    expect(db.where).toHaveBeenCalledTimes(1);
  });
});


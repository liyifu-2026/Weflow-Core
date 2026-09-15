import { describe, expect, it } from "vitest";
import {
  canFinishFallback,
  canManualTakeoverFallback,
  canReplyFallback,
  canTransferFallback,
  composerDisabled,
  composerPlaceholder,
  cycleStatusLabel,
  handoffLabel,
  normalizeHandoffStatus,
  ownershipLabel,
  transferPendingLabel,
} from "../src/lib/handoff-vocab";

describe("normalizeHandoffStatus", () => {
  it("把 Mobile 大写方言归一为 contract 小写", () => {
    expect(normalizeHandoffStatus("HANDOFF_PENDING")).toBe("pending");
    expect(normalizeHandoffStatus("TRANSFER_PENDING")).toBe("transfer_pending");
    expect(normalizeHandoffStatus("HUMAN_ACTIVE")).toBe("in_progress");
    expect(normalizeHandoffStatus("HUMAN_FINISHED")).toBe("resolved");
  });

  it("小写原样通过；空值返回 undefined", () => {
    expect(normalizeHandoffStatus("pending")).toBe("pending");
    expect(normalizeHandoffStatus(undefined)).toBeUndefined();
    expect(normalizeHandoffStatus("")).toBeUndefined();
    expect(normalizeHandoffStatus(null)).toBeUndefined();
  });
});

describe("handoffLabel / ownershipLabel", () => {
  it("四种状态标签", () => {
    expect(handoffLabel("pending")).toBe("等待接手");
    expect(handoffLabel("in_progress")).toBe("处理中");
    expect(handoffLabel("resolved")).toBe("已完成");
    expect(handoffLabel(undefined)).toBe("Agent 处理中");
  });

  it("ownershipLabel：无 handoff / 各状态 / 未知状态回落", () => {
    expect(ownershipLabel(null, false)).toBe("Agent 处理中");
    expect(ownershipLabel({ status: "pending" }, false)).toBe("等待接手");
    expect(ownershipLabel({ status: "in_progress" }, true)).toBe("我处理中");
    expect(ownershipLabel({ status: "in_progress" }, false)).toBe("其他客服处理中");
    expect(ownershipLabel({ status: "resolved" }, false)).toBe("已完成");
    expect(ownershipLabel({ status: "weird" }, false)).toBe("Agent 处理中");
  });
});

describe("transferPendingLabel", () => {
  it("非 transfer_pending 返回 null", () => {
    expect(transferPendingLabel({ status: "pending" })).toBeNull();
    expect(transferPendingLabel(null)).toBeNull();
  });
  it("队列 vs 指定客服两种文案", () => {
    expect(
      transferPendingLabel({ status: "transfer_pending", targetQueueId: "q1", targetDisplayName: "设备团队" }),
    ).toBe("已进入队列（设备团队），等待成员接手");
    expect(
      transferPendingLabel({ status: "transfer_pending", targetDisplayName: "王工" }),
    ).toBe("等待 王工 接受");
    expect(transferPendingLabel({ status: "transfer_pending" })).toBe("等待 目标客服 接受");
  });
});

describe("composer 派生", () => {
  it("placeholder：pending 提示领取；他人处理中提示只读", () => {
    expect(composerPlaceholder({ status: "pending" }, false)).toBe("先领取会话，再回复客户");
    expect(composerPlaceholder({ status: "in_progress" }, false)).toBe("其他客服正在处理");
    expect(composerPlaceholder({ status: "in_progress" }, true)).toBe("输入回复…");
    expect(composerPlaceholder(null, false)).toBe("输入回复…");
  });
  it("disabled：仅他人处理中", () => {
    expect(composerDisabled({ status: "in_progress" }, false)).toBe(true);
    expect(composerDisabled({ status: "in_progress" }, true)).toBe(false);
    expect(composerDisabled({ status: "pending" }, false)).toBe(false);
    expect(composerDisabled(null, false)).toBe(false);
  });
});

describe("capability 关闭时的本地推导回退", () => {
  it("接管条只在 Agent 处理中（无 handoff）显示", () => {
    expect(canManualTakeoverFallback(false)).toBe(true);
    expect(canManualTakeoverFallback(true)).toBe(false);
  });
  it("transfer/finish 回退为我的会话", () => {
    expect(canTransferFallback(true)).toBe(true);
    expect(canTransferFallback(false)).toBe(false);
    expect(canFinishFallback(true)).toBe(true);
    expect(canFinishFallback(false)).toBe(false);
  });
  it("canReply：pending 必须先领取；他人处理中不可回复；空文本不可回复", () => {
    expect(canReplyFallback("", { status: "resolved" }, true)).toBe(false);
    expect(canReplyFallback("你好", { status: "pending" }, false)).toBe(false);
    expect(canReplyFallback("你好", { status: "in_progress" }, false)).toBe(false);
    expect(canReplyFallback("你好", { status: "in_progress" }, true)).toBe(true);
    expect(canReplyFallback("你好", { status: "resolved" }, false)).toBe(true);
    expect(canReplyFallback("你好", null, false)).toBe(true);
  });
});

describe("cycleStatusLabel", () => {
  it("cycle 历史词汇映射，大小写不敏感", () => {
    expect(cycleStatusLabel("HANDOFF_ACCEPTED")).toBe("已接管");
    expect(cycleStatusLabel("handoff_accepted")).toBe("已接管");
    expect(cycleStatusLabel("TRANSFERRED")).toBe("已转交");
    expect(cycleStatusLabel("unknown_cycle")).toBe("unknown_cycle");
    expect(cycleStatusLabel(undefined)).toBe("交接");
  });
});

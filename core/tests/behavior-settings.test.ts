/**
 * Agent 行为参数（R2）单元测试：容错提取 + 越界回落 + 读取器装配。
 * 未配置 / 畸形输入一律回落出厂默认（与会话模式引擎常量逐字节一致）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BEHAVIOR_SETTINGS,
  extractBehaviorSettings,
} from "../modules/agent/application/behavior-settings.js";

describe("extractBehaviorSettings", () => {
  it("未配置 / 非对象输入回落出厂默认", () => {
    for (const raw of [undefined, null, 42, "x", {}, [], { behavior: null }]) {
      expect(extractBehaviorSettings(raw)).toEqual(DEFAULT_BEHAVIOR_SETTINGS);
    }
  });

  it("合法配置逐项生效", () => {
    const parsed = extractBehaviorSettings({
      behavior: {
        sessionTtlMinutes: 90,
        sessionRoundBudget: 48,
        defaultWaitMs: 600_000,
        nudgeText: "还在吗？",
        toolStepBudget: 6,
      },
    });
    expect(parsed).toEqual({
      sessionTtlMinutes: 90,
      sessionRoundBudget: 48,
      defaultWaitMs: 600_000,
      nudgeText: "还在吗？",
      toolStepBudget: 6,
    });
  });

  it("越界 / 畸形字段逐项回落默认，不影响其他字段", () => {
    const parsed = extractBehaviorSettings({
      behavior: {
        sessionTtlMinutes: 0, // 低于下限 5
        sessionRoundBudget: "many", // 类型错误
        defaultWaitMs: 20_000, // 低于 wait 下限 30s
        nudgeText: "   ", // 空白 → 默认空
        toolStepBudget: 999, // 超上限
      },
    });
    expect(parsed).toEqual(DEFAULT_BEHAVIOR_SETTINGS);
  });

  it("小数取整", () => {
    const parsed = extractBehaviorSettings({
      behavior: { sessionTtlMinutes: 45.7, toolStepBudget: 2.4 },
    });
    expect(parsed.sessionTtlMinutes).toBe(46);
    expect(parsed.toolStepBudget).toBe(2);
  });
});

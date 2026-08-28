/**
 * 主题色彩系统测试
 * 验证浅色和深色模式拥有相同的语义键，且关键色值有明显区分。
 */
import { describe, expect, it } from "vitest";
import { darkColors, lightColors } from "./theme";

describe("system theme palettes", () => {
  it("keeps identical semantic tokens in light and dark mode", () => {
    expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
  });

  it("uses distinct canvas, paper, text, and rule values in dark mode", () => {
    expect(darkColors.canvas).not.toBe(lightColors.canvas);
    expect(darkColors.paper).not.toBe(lightColors.paper);
    expect(darkColors.ink).not.toBe(lightColors.ink);
    expect(darkColors.rule).not.toBe(lightColors.rule);
  });
});

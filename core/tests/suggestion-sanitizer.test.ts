/**
 * 建议回复清洗层测试（§30 验收样例）
 * 覆盖：Markdown 剥离、前缀剥离、空白压缩、说明书式列表、纯文本保证。
 */
import { describe, expect, it } from "vitest";
import { normalizeSuggestionText } from "../modules/knowledge/application/suggestion-sanitizer.js";

describe("suggestion sanitizer", () => {
  it("strips bold and heading markdown", () => {
    expect(normalizeSuggestionText("**建议您先检查以下几点：**")).toBe(
      "建议您先检查以下几点：",
    );
    expect(normalizeSuggestionText("# 标题\n正文")).toBe("标题 正文");
  });

  it("flattens ordered and unordered lists into plain sentences", () => {
    const input = "建议按以下步骤操作：\n1. 检查电源\n- 检查网络\n2. 重启";
    expect(normalizeSuggestionText(input)).toBe(
      "建议按以下步骤操作：检查电源 检查网络 重启",
    );
  });

  it("strips inline code and links", () => {
    expect(normalizeSuggestionText("请查看 `设置` 页面")).toBe(
      "请查看 设置 页面",
    );
    expect(normalizeSuggestionText("详见[使用手册](https://x.com)")).toBe(
      "详见使用手册",
    );
  });

  it("strips blockquote lines", () => {
    expect(normalizeSuggestionText("> 引用内容\n回复正文")).toBe(
      "引用内容 回复正文",
    );
  });

  it("strips common prefixes", () => {
    expect(normalizeSuggestionText("建议回复：您好，请确认版本。")).toBe(
      "您好，请确认版本。",
    );
    expect(normalizeSuggestionText("建议：先确认指示灯状态")).toBe(
      "先确认指示灯状态",
    );
  });

  it("removes fenced code blocks entirely", () => {
    const input = "```\nerror: 2272\n```\n请确认固件版本";
    expect(normalizeSuggestionText(input)).toBe("请确认固件版本");
  });

  it("collapses excess whitespace and empty lines", () => {
    expect(normalizeSuggestionText("第一句\n\n\n  第二句  ")).toBe(
      "第一句 第二句",
    );
  });

  it("keeps plain natural replies untouched", () => {
    const input = "好的，那我们再确认一下门锁当前显示的错误提示是什么。";
    expect(normalizeSuggestionText(input)).toBe(input);
  });

  it("returns empty input unchanged", () => {
    expect(normalizeSuggestionText("")).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import {
  normalizeReplyText,
  replyFingerprint,
} from "../modules/agent/application/duplicate-reply.js";

describe("normalizeReplyText", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeReplyText("  好的，明白了。\n")).toBe("好的，明白了。");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeReplyText("好的，明白了。\n\n请问还有其他问题吗？")).toBe(
      "好的，明白了。 请问还有其他问题吗？",
    );
  });

  it("keeps identical text stable for comparison", () => {
    const original = "1+1等于2。请问您还有其他问题吗？";
    expect(normalizeReplyText(original)).toBe(
      normalizeReplyText(` ${original} `),
    );
  });
});

describe("replyFingerprint", () => {
  it("同几句话换序 → 指纹相同（换序复读判重）", () => {
    const first = "别急，先离屏幕远点。\n\n我拉技术同事一起看看。";
    const restated = "我拉技术同事一起看看。\n\n别急，先离屏幕远点。";
    expect(replyFingerprint(restated)).toBe(replyFingerprint(first));
  });

  it("逐字复读 → 指纹相同", () => {
    const first = "好的，我明白了。";
    expect(replyFingerprint(first)).toBe(replyFingerprint("好的，我明白了。"));
  });

  it("空白差异被归一化", () => {
    expect(replyFingerprint("  好的。  \n\n收到。\n")).toBe(
      replyFingerprint("好的。\n\n收到。"),
    );
  });

  it("内容不同 → 指纹不同", () => {
    expect(replyFingerprint("好的。")).not.toBe(replyFingerprint("收到。"));
    expect(replyFingerprint("好的。\n\n收到。")).not.toBe(
      replyFingerprint("好的。"),
    );
  });

  it("空段与全空白 → 空指纹", () => {
    expect(replyFingerprint("  \n\n  ")).toBe("");
  });
});

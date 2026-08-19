import { describe, expect, it } from "vitest";
import { normalizeReplyText } from "../modules/agent/application/duplicate-reply.js";

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

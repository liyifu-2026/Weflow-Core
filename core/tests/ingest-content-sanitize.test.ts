import { describe, expect, it } from "vitest";
import {
  sanitizeInboundContent,
  stripInboundHtml,
  UNKNOWN_CUSTOMER_TEXT,
} from "../modules/conversations/application/ingest-channel-events.js";

describe("stripInboundHtml", () => {
  it("keeps plain text untouched (fast path)", () => {
    expect(stripInboundHtml("你好，在吗？")).toBe("你好，在吗？");
  });

  it("keeps link url alongside inner text for labelled anchors", () => {
    expect(stripInboundHtml("看<a href=\"https://x.y\">这个</a>就知道")).toBe(
      "看这个 (https://x.y)就知道",
    );
  });

  it("keeps link target when anchor has a label", () => {
    expect(
      stripInboundHtml(
        '<a href="https://weixin110.qq.com/cgi-bin/faq">查看详情</a>',
      ),
    ).toBe("查看详情 (https://weixin110.qq.com/cgi-bin/faq)");
  });

  it("keeps bare anchor url when label is empty or identical", () => {
    expect(stripInboundHtml('<a href="https://x.y"></a>')).toBe("https://x.y");
    expect(stripInboundHtml('<a href="https://x.y">https://x.y</a>')).toBe(
      "https://x.y",
    );
  });

  it("strips nested/wrapped tags wholesale", () => {
    expect(stripInboundHtml("<p>段落</p><br/>尾随")).toBe("段落尾随");
  });
});

describe("sanitizeInboundContent", () => {
  it("replaces body that equals senderRef with placeholder (ISS-006)", () => {
    expect(
      sanitizeInboundContent(
        "text",
        "user_3YJ13REXhVzQ9pXkLmNoPqRsTuVw",
        "user_3YJ13REXhVzQ9pXkLmNoPqRsTuVw",
      ),
    ).toBe(UNKNOWN_CUSTOMER_TEXT);
  });

  it("replaces bare long channel-ref body even when sender differs", () => {
    expect(
      sanitizeInboundContent("text", "user_2EiuUuF2aBcDeFgHiJkLm", "other"),
    ).toBe(UNKNOWN_CUSTOMER_TEXT);
  });

  it("does not touch short user-like text a human may have typed", () => {
    expect(sanitizeInboundContent("text", "user_abc", null)).toBe("user_abc");
  });

  it("does not touch ids embedded in a real sentence", () => {
    const msg = "我的账号是 user_3YJ13REXhVzQ9pXkLmNoPqRsTuVw 帮我查下";
    expect(sanitizeInboundContent("text", msg, "someone")).toBe(msg);
  });

  it("strips html in text events", () => {
    expect(
      sanitizeInboundContent(
        "text",
        '微信团队<a href="https://weixin110.qq.com">提醒</a>',
        null,
      ),
    ).toBe("微信团队提醒 (https://weixin110.qq.com)");
  });

  it("leaves non-text kinds (image/emotion mediaRef) untouched", () => {
    const raw = "<EmojiInfoRaw>whatever</EmojiInfoRaw>";
    expect(sanitizeInboundContent("image", raw, null)).toBe(raw);
  });

  it("leaves pat text through the html strip only", () => {
    expect(sanitizeInboundContent("pat", "拍了拍", null)).toBe("拍了拍");
  });
});

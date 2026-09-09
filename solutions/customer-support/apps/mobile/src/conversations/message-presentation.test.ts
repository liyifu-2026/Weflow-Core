/**
 * 消息展示分类测试
 * 验证 AI、人工、客户和系统消息的分类逻辑，以及拍一拍与表情包消息的文本化展示。
 */
import { describe, expect, it } from "vitest";
import {
  emotionDisplayText,
  messageKind,
  patNoticeText,
} from "./message-presentation";

describe("message presentation", () => {
  it("keeps AI and human replies visually distinct without relying on direction", () => {
    expect(messageKind("agent", "outbound")).toBe("agent");
    expect(messageKind("user", "outbound")).toBe("manual");
  });

  it("treats inbound channel messages as customer messages", () => {
    expect(messageKind("wechat_contact", "inbound")).toBe("customer");
  });

  it("keeps non-chat outbound facts on the system timeline", () => {
    expect(messageKind("system", "outbound")).toBe("system");
  });
});

describe("pat notice messages", () => {
  it("renders pat messages as a centered notice using the server text", () => {
    expect(
      patNoticeText({ contentType: "pat", text: "对方拍了拍你" }),
    ).toBe("对方拍了拍你");
  });

  it("falls back to the default copy when pat text is blank", () => {
    expect(patNoticeText({ contentType: "pat", text: "  " })).toBe(
      "对方拍了拍你",
    );
    expect(patNoticeText({ contentType: "pat", text: "" })).toBe(
      "对方拍了拍你",
    );
  });

  it("ignores non-pat messages", () => {
    expect(patNoticeText({ contentType: "text", text: "你好" })).toBeNull();
    expect(patNoticeText({ contentType: "image", text: "" })).toBeNull();
  });
});

describe("emotion (sticker) messages", () => {
  it("renders emotion messages as plain text without touching media", () => {
    expect(
      emotionDisplayText({ contentType: "emotion", text: "[表情包]开心" }),
    ).toBe("[表情包]开心");
  });

  it("falls back to a placeholder when the meaning is missing", () => {
    expect(emotionDisplayText({ contentType: "emotion", text: "" })).toBe(
      "[表情包]表情",
    );
    expect(emotionDisplayText({ contentType: "emotion", text: "  " })).toBe(
      "[表情包]表情",
    );
  });

  it("leaves other content types untouched", () => {
    expect(emotionDisplayText({ contentType: "text", text: "哈哈" })).toBeNull();
    expect(emotionDisplayText({ contentType: "image", text: "" })).toBeNull();
  });
});

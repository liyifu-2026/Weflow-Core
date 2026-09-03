import { describe, expect, it } from "vitest";

import {
  mediaAwareMessageText,
} from "../modules/agent/application/media-context.js";

describe("mediaAwareMessageText（Phase 4 视觉直读装配规则）", () => {
  it("图片有描述（含模型自写 media_notes）→ 图片观察", () => {
    expect(
      mediaAwareMessageText({
        contentType: "image",
        mediaDescription: "订单截图，尾号8823，金额299元",
      }),
    ).toBe("图片观察：订单截图，尾号8823，金额299元");
  });

  it("图片无描述 → 可看图信号（模型可用 fetch_url 拉原图），不编造", () => {
    const text = mediaAwareMessageText({
      contentType: "image",
      mediaDescription: null,
      originalImageUrl: "https://cdn.example/1.png",
      messageId: "msg:1",
    });
    expect(text).toContain("[对方发送了一张图片");
    expect(text).toContain("msg:1");
    expect(text).toContain("原图可查看");
  });

  it("图片无描述也无原图 URL → 诚实占位", () => {
    expect(
      mediaAwareMessageText({
        contentType: "image",
        mediaDescription: null,
        originalImageUrl: null,
        messageId: "msg:2",
      }),
    ).toBe("[对方发送了一张图片，当前无法查看内容]");
  });

  it("语音行为不变：有转写用转写，无转写诚实占位", () => {
    expect(
      mediaAwareMessageText({
        contentType: "voice",
        mediaDescription: "你们这个退款多久到账",
      }),
    ).toBe("语音转写：你们这个退款多久到账");
    expect(
      mediaAwareMessageText({
        contentType: "voice",
        mediaDescription: null,
        text: "",
      }),
    ).toBe("[对方发来一条语音，转写不可用]");
    expect(
      mediaAwareMessageText({
        contentType: "voice",
        mediaDescription: null,
        text: "语音原文",
      }),
    ).toBe("语音转写：语音原文");
  });

  it("非媒体消息原样透传", () => {
    expect(
      mediaAwareMessageText({ contentType: "text", text: "在吗" }),
    ).toBe("在吗");
  });
});

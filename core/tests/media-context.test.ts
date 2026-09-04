import { describe, expect, it } from "vitest";

import {
  mediaAwareMessageText,
} from "../modules/agent/application/media-context.js";

describe("mediaAwareMessageText（媒体上下文装配规则）", () => {
  it("图片有描述（含模型自写 media_notes）→ 图片观察", () => {
    expect(
      mediaAwareMessageText({
        contentType: "image",
        mediaDescription: "订单截图，尾号8823，金额299元",
      }),
    ).toBe("图片观察：订单截图，尾号8823，金额299元");
  });

  it("图片无描述 → 诚实占位（不编造，不引导必然失败的工具调用）", () => {
    expect(
      mediaAwareMessageText({
        contentType: "image",
        mediaDescription: null,
        messageId: "msg:1",
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

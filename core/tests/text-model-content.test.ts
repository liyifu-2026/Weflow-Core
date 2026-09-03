import { describe, expect, it } from "vitest";

import {
  isMultimodalContent,
  textOfContent,
  type TextModelMessage,
} from "../modules/model/contracts/text-generation-request.js";

describe("TextModelMessage multimodal content（Phase 4 视觉直读）", () => {
  it("纯文本消息保持 string content（全兼容既有调用点）", () => {
    const message: TextModelMessage = { role: "user", content: "在吗" };
    expect(message.content).toBe("在吗");
    expect(isMultimodalContent(message.content)).toBe(false);
    expect(textOfContent(message.content)).toBe("在吗");
  });

  it("图文混合消息用 ContentPart 数组（text + image_url）", () => {
    const message: TextModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "这张图里是什么订单？" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/order.png" },
        },
      ],
    };
    expect(isMultimodalContent(message.content)).toBe(true);
    expect(textOfContent(message.content)).toBe("这张图里是什么订单？");
  });

  it("textOfContent 对数组提取全部 text 段拼接，忽略图片段", () => {
    expect(
      textOfContent([
        { type: "text", text: "第一段。" },
        { type: "image_url", image_url: { url: "x://y" } },
        { type: "text", text: "第二段。" },
      ]),
    ).toBe("第一段。第二段。");
    expect(textOfContent([{ type: "image_url", image_url: { url: "x" } }])).toBe(
      "",
    );
  });
});

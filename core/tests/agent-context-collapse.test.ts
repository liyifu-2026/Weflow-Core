/**
 * 上下文折叠回归（2026-09-07 可可猫群）：窗口尾部连续 assistant 消息
 * （复读/拆条连发）会让 vision-exp 输出纯空白 → 失败转人工。
 * collapseConsecutiveAssistantMessages 把连续 assistant 折叠为一条。
 */
import { describe, expect, it } from "vitest";
import { collapseConsecutiveAssistantMessages } from "../modules/agent/application/agent-context.js";

describe("collapseConsecutiveAssistantMessages", () => {
  it("折叠连续 assistant 消息为一条（\n 连接）", () => {
    const result = collapseConsecutiveAssistantMessages([
      { role: "user", content: "@客服 你看到了什么" },
      { role: "assistant", content: "看到了，有事说事" },
      { role: "assistant", content: "看到了，有问题直说" },
      { role: "assistant", content: "看到了，有事说事" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("assistant");
    expect(result[1]?.content).toBe(
      "看到了，有事说事\n看到了，有问题直说\n看到了，有事说事",
    );
  });

  it("不打断 user/assistant 交替结构", () => {
    const result = collapseConsecutiveAssistantMessages([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，有什么问题？" },
      { role: "user", content: "v9打不开" },
      { role: "assistant", content: "重启试试。" },
    ]);
    expect(result).toHaveLength(4);
  });

  it("多模态 assistant 段不参与合并（保持原样）", () => {
    const imageContent = [
      { type: "text" as const, text: "带图回复" },
      { type: "image_url" as const, image_url: { url: "data:x" } },
    ];
    const result = collapseConsecutiveAssistantMessages([
      { role: "assistant", content: "第一条" },
      { role: "assistant", content: imageContent },
      { role: "assistant", content: "第二条" },
    ]);
    expect(result).toHaveLength(3);
  });

  it("折叠后相邻的 assistant 再被合并（多轮连发场景）", () => {
    const result = collapseConsecutiveAssistantMessages([
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
      { role: "assistant", content: "c" },
      { role: "user", content: "问" },
      { role: "assistant", content: "d" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]?.content).toBe("a\nb\nc");
  });
});

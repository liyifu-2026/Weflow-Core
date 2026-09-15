import { describe, expect, it } from "vitest";
import { isGroupNoiseText } from "../modules/agent/application/agent-context.js";

describe("群聊噪声判定 isGroupNoiseText", () => {
  it("表情包占位 → 噪声", () => {
    expect(isGroupNoiseText("[呲牙][呲牙][呲牙]")).toBe(true);
    expect(isGroupNoiseText("[笑脸]")).toBe(true);
  });

  it("纯标点/空白 → 噪声", () => {
    expect(isGroupNoiseText("。。。")).toBe(true);
    expect(isGroupNoiseText("？？？？！")).toBe(true);
    expect(isGroupNoiseText("   ")).toBe(true);
    expect(isGroupNoiseText("")).toBe(true);
  });

  it("emoji-only → 噪声", () => {
    expect(isGroupNoiseText("😀😀😀")).toBe(true);
  });

  it("实质消息 → 非噪声", () => {
    expect(isGroupNoiseText("v9打不开")).toBe(false);
    expect(isGroupNoiseText("@客服 报错误码2272")).toBe(false);
    expect(isGroupNoiseText("哈哈 это test123")).toBe(false);
  });

  it("混合（表情+实质）→ 非噪声", () => {
    expect(isGroupNoiseText("[呲牙] 谢谢大佬")).toBe(false);
  });
});

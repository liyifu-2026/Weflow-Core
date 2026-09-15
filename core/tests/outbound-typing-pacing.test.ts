/**
 * 打字节拍（interSegmentDelayMs）单元测试。
 *
 * 钉住三件事：确定性（同种子同延迟）、有界（600ms ~ 上限）、随文本
 * 长度单调不减（打字时间线性项）。
 */
import { describe, expect, it } from "vitest";
import { interSegmentDelayMs } from "../modules/conversations/application/process-outbound-messages.js";

describe("interSegmentDelayMs", () => {
  it("同一 (text, messageId) 结果确定", () => {
    const a = interSegmentDelayMs("重启一下。", "agent-message:t1:2");
    const b = interSegmentDelayMs("重启一下。", "agent-message:t1:2");
    expect(a).toBe(b);
  });

  it("延迟始终落在 [600, 7200] 区间", () => {
    const samples = ["好。", "先断电，等十秒再上电。", "x".repeat(400)];
    for (let i = 0; i < 50; i += 1) {
      for (const text of samples) {
        const delay = interSegmentDelayMs(text, `agent-message:t:${i}`);
        expect(delay).toBeGreaterThanOrEqual(600);
        expect(delay).toBeLessThanOrEqual(7_200);
      }
    }
  });

  it("短讯几乎立即跟上，长段需要更多打字时间（统计上单调）", () => {
    const short = Array.from({ length: 30 }, (_, i) =>
      interSegmentDelayMs("好。", `m:s:${i}`),
    );
    const long = Array.from({ length: 30 }, (_, i) =>
      interSegmentDelayMs(
        "把加密狗换到另一个USB口，再打开软件试试看。",
        `m:l:${i}`,
      ),
    );
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(long)).toBeGreaterThan(avg(short));
  });

  it("不同种子的抖动确实生效（并非所有延迟相同）", () => {
    const delays = new Set(
      Array.from({ length: 30 }, (_, i) =>
        interSegmentDelayMs("稍等。", `m:j:${i}`),
      ),
    );
    expect(delays.size).toBeGreaterThan(1);
  });
});

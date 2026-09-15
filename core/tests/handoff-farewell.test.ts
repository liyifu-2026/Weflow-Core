/**
 * handoff 告别话术净化单元测试。
 * 告别语是锦上添花：超限内容静默丢弃，绝不让转人工本身失败。
 */
import { describe, expect, it } from "vitest";
import { sanitizeFarewellSegments } from "../modules/handoff/application/handoff-service.js";
import { MAX_REPLY_SEGMENTS } from "../modules/agent/application/decision-contract.js";

describe("sanitizeFarewellSegments", () => {
  it("undefined/空数组 → 空数组（静默转接）", () => {
    expect(sanitizeFarewellSegments(undefined)).toEqual([]);
    expect(sanitizeFarewellSegments([])).toEqual([]);
  });

  it("trim 去空白段；全空白 → 空数组", () => {
    expect(
      sanitizeFarewellSegments(["  转同事看一下，稍等。  ", "   "]),
    ).toEqual(["转同事看一下，稍等。"]);
    expect(sanitizeFarewellSegments(["  ", "\n\t"])).toEqual([]);
  });

  it("超过 MAX_REPLY_SEGMENTS 条 → 静默截断，不失败", () => {
    const segments = Array.from(
      { length: MAX_REPLY_SEGMENTS + 3 },
      (_, index) => `第${String(index + 1)}条`,
    );
    const cleaned = sanitizeFarewellSegments(segments);
    expect(cleaned).toHaveLength(MAX_REPLY_SEGMENTS);
  });

  it("单条超长 → 截断到 500 字符", () => {
    const cleaned = sanitizeFarewellSegments(["长".repeat(600)]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toHaveLength(500);
  });
});

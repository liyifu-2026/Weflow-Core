/**
 * 联系人标签工具测试
 * 验证中文逗号、ASCII 逗号和换行符分隔，以及去重和格式化逻辑。
 */
import { describe, expect, it } from "vitest";
import { contactTagsInput, normalizeContactTags } from "./contact-profile";

describe("contact profile tags", () => {
  it("accepts Chinese commas, ASCII commas, and line breaks", () => {
    expect(normalizeContactTags("重点客户，设备故障\n需回访, 华南")).toEqual([
      "重点客户",
      "设备故障",
      "需回访",
      "华南",
    ]);
  });

  it("removes empty and duplicate tags before sending", () => {
    expect(normalizeContactTags(" 重点客户, ,重点客户，需回访 ")).toEqual([
      "重点客户",
      "需回访",
    ]);
  });

  it("formats existing tags for editing", () => {
    expect(contactTagsInput(["重点客户", "需回访"])).toBe("重点客户，需回访");
  });
});

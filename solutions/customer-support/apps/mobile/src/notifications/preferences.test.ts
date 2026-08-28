/**
 * 通知注册隐私策略测试
 * 验证新设备默认隐藏消息预览，以及保留上次确认的偏好。
 */
import { describe, expect, it } from "vitest";
import { registrationPreviewPreference } from "./policy";

describe("notification registration privacy", () => {
  it("defaults new devices to hidden message previews", () => {
    expect(registrationPreviewPreference(undefined)).toBe(false);
  });

  it("preserves the last Core-confirmed choice during re-registration", () => {
    expect(
      registrationPreviewPreference({
        showPreview: true,
        confirmedAt: "2026-08-03T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});

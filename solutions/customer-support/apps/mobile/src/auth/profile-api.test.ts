import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "@/api/client";
import type { MobileSession } from "@/auth/session";
import { profileErrorCopy } from "./error-copy";
import { fetchTagVocabulary, updateProfile } from "./api";

// vitest 会将 vi.mock 提升到所有 import 之上，因此可以放在 import 之后
vi.mock("@/api/client", () => ({
  request: vi.fn(),
}));

const session: MobileSession = {
  sessionToken: "test-token",
  expiresAt: "2099-01-01T00:00:00.000Z",
  user: { userId: "agent-1", username: "leaif", mustChangePassword: false },
};

const mockedRequest = vi.mocked(request);

beforeEach(() => {
  mockedRequest.mockReset();
});

describe("updateProfile（信息名片资料更新）", () => {
  it("以 PUT /api/v1/auth/me 提交显示名与标签并返回更新后的用户", async () => {
    mockedRequest.mockResolvedValue({
      user: { ...session.user, displayName: "射频小王", tags: ["device_fault"] },
    });

    const user = await updateProfile(session, {
      displayName: "射频小王",
      tags: ["device_fault"],
    });

    expect(mockedRequest).toHaveBeenCalledWith("/api/v1/auth/me", {
      method: "PUT",
      token: "test-token",
      body: JSON.stringify({ displayName: "射频小王", tags: ["device_fault"] }),
    });
    expect(user).toMatchObject({ displayName: "射频小王", tags: ["device_fault"] });
  });

  it("清空显示名时原样提交 null（回落为登录账号）", async () => {
    mockedRequest.mockResolvedValue({ user: { ...session.user, displayName: null } });

    await updateProfile(session, { displayName: null });

    expect(mockedRequest).toHaveBeenCalledWith(
      "/api/v1/auth/me",
      expect.objectContaining({
        body: JSON.stringify({ displayName: null }),
      }),
    );
  });
});

describe("fetchTagVocabulary（名片标签词表）", () => {
  it("请求词表并返回标签数组", async () => {
    mockedRequest.mockResolvedValue({
      tags: [
        { key: "device_fault", displayName: "设备故障" },
        { key: "after_sales", displayName: "售后与投诉" },
      ],
    });

    const tags = await fetchTagVocabulary(session);

    expect(mockedRequest).toHaveBeenCalledWith("/api/v1/auth/tag-vocabulary", {
      token: "test-token",
    });
    expect(tags).toEqual([
      { key: "device_fault", displayName: "设备故障" },
      { key: "after_sales", displayName: "售后与投诉" },
    ]);
  });
});

describe("profileErrorCopy（名片错误文案）", () => {
  it("映射资料类错误码为中文提示", () => {
    expect(profileErrorCopy("invalid_display_name")).toContain("显示名");
    expect(profileErrorCopy("unknown_tag")).toContain("标签");
    expect(profileErrorCopy("invalid_request")).toContain("格式");
  });

  it("未知错误码回落到通用提示", () => {
    expect(profileErrorCopy("something_else")).toBe("保存失败，请稍后重试。");
  });
});

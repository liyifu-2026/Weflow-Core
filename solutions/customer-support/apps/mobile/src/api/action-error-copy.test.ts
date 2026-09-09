/**
 * 操作错误提示文案测试
 * 验证各类错误码和状态码能正确映射为用户可读的中文提示。
 */
import { describe, expect, it } from "vitest";
import { actionErrorCopy } from "./action-error-copy";

describe("action error copy", () => {
  it("does not describe a Core failure as a network problem", () => {
    expect(actionErrorCopy({ code: "request_failed", status: 500 })).toEqual({
      title: "服务暂时不可用",
      message: "本次操作没有完成",
    });
  });

  it("uses a network message only when no HTTP response exists", () => {
    expect(actionErrorCopy()).toEqual({
      title: "网络连接失败",
      message: "请稍后重试",
    });
  });

  it("explains when a transfer target is no longer available", () => {
    expect(
      actionErrorCopy({ code: "handoff_assignee_not_found", status: 404 }),
    ).toEqual({
      title: "该同事当前不可接收会话",
      message: "请重新选择",
    });
  });
});

/**
 * 登录页静默自动登录策略测试
 * 回归锁定：用户主动退出/切换账号（manual 参数）后不得静默自动登录。
 */
import { describe, expect, it } from "vitest";
import { shouldAttemptAutoLogin } from "./auto-login-policy";

describe("shouldAttemptAutoLogin allows silent sign-in on cold start", () => {
  it("permits auto-login when no entry params are present", () => {
    expect(shouldAttemptAutoLogin({})).toBe(true);
  });
});

describe("shouldAttemptAutoLogin suppresses auto-login after manual sign-out", () => {
  it("blocks auto-login when the manual flag is set", () => {
    expect(shouldAttemptAutoLogin({ manual: "1" })).toBe(false);
  });
});

describe("shouldAttemptAutoLogin suppresses auto-login for prefilled accounts", () => {
  it("blocks auto-login when a username param prefills the form", () => {
    expect(shouldAttemptAutoLogin({ username: "leaif" })).toBe(false);
  });

  it("treats a blank username param as absent", () => {
    expect(shouldAttemptAutoLogin({ username: "   " })).toBe(true);
  });
});

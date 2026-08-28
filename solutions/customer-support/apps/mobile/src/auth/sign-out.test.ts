/**
 * 账号退出测试
 * 验证无本地会话和服务端登出失败时仍能正确清除本地状态。
 */
import { describe, expect, it, vi } from "vitest";
import { leaveAccount } from "./sign-out";

describe("account exit", () => {
  it("opens sign-in even when no local session was loaded", async () => {
    const logout = vi.fn();
    const clear = vi.fn().mockResolvedValue(undefined);
    const showSignIn = vi.fn();

    await leaveAccount(undefined, { logout, clear, showSignIn });

    expect(logout).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledOnce();
    expect(showSignIn).toHaveBeenCalledOnce();
  });

  it("clears local state and opens sign-in when server logout fails", async () => {
    const logout = vi.fn().mockRejectedValue(new Error("revoked"));
    const clear = vi.fn().mockResolvedValue(undefined);
    const showSignIn = vi.fn();
    const session = {
      sessionToken: "expired-token",
      expiresAt: "2026-08-04T00:00:00.000Z",
      user: { userId: "u-1", username: "leaif", mustChangePassword: false },
    };

    await leaveAccount(session, { logout, clear, showSignIn });

    expect(clear).toHaveBeenCalledOnce();
    expect(showSignIn).toHaveBeenCalledOnce();
  });

  it("revokes the current device before clearing the session", async () => {
    const revokeDevice = vi.fn().mockResolvedValue(undefined);
    const logout = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn().mockResolvedValue(undefined);
    const showSignIn = vi.fn();
    const session = {
      sessionToken: "session-token",
      expiresAt: "2026-08-04T00:00:00.000Z",
      user: { userId: "u-1", username: "leaif", mustChangePassword: false },
    };

    await leaveAccount(session, { revokeDevice, logout, clear, showSignIn });

    expect(revokeDevice).toHaveBeenCalledOnce();
    expect(revokeDevice.mock.invocationCallOrder[0]).toBeLessThan(
      clear.mock.invocationCallOrder[0]!,
    );
    expect(showSignIn).toHaveBeenCalledOnce();
  });

  it("does not block local sign-out when device revocation fails", async () => {
    const revokeDevice = vi.fn().mockRejectedValue(new Error("offline"));
    const clear = vi.fn().mockResolvedValue(undefined);
    const showSignIn = vi.fn();
    const session = {
      sessionToken: "session-token",
      expiresAt: "2026-08-04T00:00:00.000Z",
      user: { userId: "u-1", username: "leaif", mustChangePassword: false },
    };

    await leaveAccount(session, {
      revokeDevice,
      logout: vi.fn(),
      clear,
      showSignIn,
    });

    expect(clear).toHaveBeenCalledOnce();
    expect(showSignIn).toHaveBeenCalledOnce();
  });

  it("still opens sign-in when clearing local state throws", async () => {
    const clear = vi
      .fn()
      .mockRejectedValue(new Error("secure store unavailable"));
    const showSignIn = vi.fn();
    const session = {
      sessionToken: "session-token",
      expiresAt: "2026-08-04T00:00:00.000Z",
      user: { userId: "u-1", username: "leaif", mustChangePassword: false },
    };

    await leaveAccount(session, {
      logout: vi.fn().mockResolvedValue(undefined),
      clear,
      showSignIn,
    });

    expect(clear).toHaveBeenCalledOnce();
    expect(showSignIn).toHaveBeenCalledOnce();
  });

  it("bounded network cleanup: a hanging logout cannot block navigation", async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<void>(() => {});
    const clear = vi.fn().mockResolvedValue(undefined);
    const showSignIn = vi.fn();
    const session = {
      sessionToken: "session-token",
      expiresAt: "2026-08-04T00:00:00.000Z",
      user: { userId: "u-1", username: "leaif", mustChangePassword: false },
    };

    const pending = leaveAccount(session, {
      logout: vi.fn(() => neverSettles),
      clear,
      showSignIn,
    });
    await vi.advanceTimersByTimeAsync(5_100);
    await pending;

    expect(clear).toHaveBeenCalledOnce();
    expect(showSignIn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("bounded network cleanup: a hanging device revocation cannot block navigation", async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<void>(() => {});
    const clear = vi.fn().mockResolvedValue(undefined);
    const showSignIn = vi.fn();
    const session = {
      sessionToken: "session-token",
      expiresAt: "2026-08-04T00:00:00.000Z",
      user: { userId: "u-1", username: "leaif", mustChangePassword: false },
    };

    const pending = leaveAccount(session, {
      revokeDevice: vi.fn(() => neverSettles),
      logout: vi.fn().mockResolvedValue(undefined),
      clear,
      showSignIn,
    });
    await vi.advanceTimersByTimeAsync(5_100);
    await pending;

    expect(clear).toHaveBeenCalledOnce();
    expect(showSignIn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

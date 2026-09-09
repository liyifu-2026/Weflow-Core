/**
 * HTTP API 客户端测试
 * 验证认证失效（401）时正确触发重新登录事件，以及未认证请求不会误触发登出循环。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeAuthenticationRequired } from "../auth/auth-events";
import { ApiError, request } from "./client";

vi.mock("./config", () => ({ apiBaseUrl: "https://core.test" }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authenticated API failures", () => {
  it("requests a fresh login when Core rejects the bearer token", async () => {
    const authenticationRequired = vi.fn();
    const unsubscribe = subscribeAuthenticationRequired(authenticationRequired);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "session_expired" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(request("/mobile/conversations", { token: "expired" })).rejects.toEqual(
      new ApiError("session_expired", 401),
    );
    expect(authenticationRequired).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("does not start a logout loop for an unauthenticated login failure", async () => {
    const authenticationRequired = vi.fn();
    const unsubscribe = subscribeAuthenticationRequired(authenticationRequired);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(request("/mobile/auth/login")).rejects.toEqual(
      new ApiError("invalid_credentials", 401),
    );
    expect(authenticationRequired).not.toHaveBeenCalled();
    unsubscribe();
  });
});

/**
 * Knora HTTP 客户端单元测试（characterization）。
 * knora-http 直接使用全局 fetch（无注入缝），因此在全局 fetch 边界打桩；
 * 断言请求形状、鉴权头、错误分类（KnoraHttpError：HTTP 状态 vs status 0 网络故障）
 * 与超时中止路径。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KnoraHttpError,
  knoraAddMember,
  knoraGetTenant,
  knoraLogin,
  knoraRegister,
  type KnoraUpstream,
} from "./knora-http.js";

const upstream: KnoraUpstream = {
  baseUrl: "http://weknora.test/api/v1",
  apiKey: "tenant-api-key",
  timeoutMs: 1_000,
};

function lastHeaders(): Record<string, string> {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const init = calls[calls.length - 1]?.[1];
  return (init?.headers ?? {}) as Record<string, string>;
}

/** RequestInit.body 安全读取（避免 no-base-to-string 的 String(obj)） */
function parseBody(body: unknown): unknown {
  if (typeof body === "string") return JSON.parse(body);
  expect(body).toBeDefined();
  return JSON.parse(JSON.stringify(body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("knora-http", () => {
  it("registers by POSTing JSON to /auth/register and reads user.id", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json({
        user: { id: "knora-user-1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      knoraRegister(upstream, {
        username: "alice",
        email: "alice@weflow.com",
        password: "pw",
      }),
    ).resolves.toEqual({ userId: "knora-user-1" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://weknora.test/api/v1/auth/register",
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(parseBody(init?.body)).toEqual({
      username: "alice",
      email: "alice@weflow.com",
      password: "pw",
    });
    // 公开接口不带租户 API Key
    expect(lastHeaders()["x-api-key"]).toBeUndefined();
  });

  it("returns an empty userId when the register response has no user id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({})),
    );
    await expect(
      knoraRegister(upstream, {
        username: "a",
        email: "a@weflow.com",
        password: "p",
      }),
    ).resolves.toEqual({ userId: "" });
  });

  it("logs in without auth headers and returns the parsed body", async () => {
    const body = {
      token: "t1",
      refresh_token: "r1",
      user: { id: "u" },
      active_tenant: null,
      memberships: [],
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json(body)),
    );
    await expect(
      knoraLogin(upstream, { email: "a@weflow.com", password: "p" }),
    ).resolves.toEqual(body);
    expect(lastHeaders()["authorization"]).toBeUndefined();
  });

  it("authenticates member management with the tenant API key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({})),
    );
    await expect(
      knoraAddMember(upstream, {
        tenantId: 42,
        email: "a@weflow.com",
        role: "admin",
      }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]).toBe(
      "http://weknora.test/api/v1/tenants/42/members",
    );
    expect(lastHeaders()).toMatchObject({
      "x-api-key": "tenant-api-key",
      "content-type": "application/json",
    });
    expect(
      parseBody(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body),
    ).toEqual({
      email: "a@weflow.com",
      role: "admin",
    });
  });

  it("reads the active tenant with bearer auth", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json({ id: 42, name: "Workspace" })),
    );
    await expect(
      knoraGetTenant(upstream, { tenantId: 42, bearer: "tok" }),
    ).resolves.toEqual({ id: 42, name: "Workspace" });
    expect(lastHeaders().authorization).toBe("Bearer tok");
  });

  it("maps upstream error bodies onto KnoraHttpError with status/message/code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "邮箱已存在", code: 40007 } }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const error = await knoraRegister(upstream, {
      username: "a",
      email: "taken@weflow.com",
      password: "p",
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(KnoraHttpError);
    expect(error).toMatchObject({
      status: 409,
      message: "邮箱已存在",
      code: 40007,
    });
  });

  it("falls back to a generic message for non-JSON error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response("gateway timeout", { status: 504 }),
        ),
    );
    const error = await knoraLogin(upstream, {
      email: "a@weflow.com",
      password: "p",
    }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      status: 504,
      message: "knora /auth/login -> HTTP 504",
    });
  });

  it("classifies transport failures as KnoraHttpError with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValueOnce(new TypeError("fetch failed")),
    );
    await expect(
      knoraLogin(upstream, { email: "a@weflow.com", password: "p" }),
    ).rejects.toMatchObject({
      name: "KnoraHttpError",
      status: 0,
      message: "fetch failed",
    });
  });

  it("aborts slow upstreams and surfaces the timeout as status 0", async () => {
    // 挂起的 fetch：仅在 abort 触发时 reject，真实走 knoraFetch 的 setTimeout 中止路径
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("The operation was aborted"));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      knoraLogin(
        { ...upstream, timeoutMs: 5 },
        { email: "a@weflow.com", password: "p" },
      ),
    ).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
  }, 5_000);

  it("stamps a unique x-request-id per request", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(Response.json({})));
    vi.stubGlobal("fetch", fetchMock);

    await knoraAddMember(upstream, {
      tenantId: 1,
      email: "e@x.com",
      role: "admin",
    });
    await knoraAddMember(upstream, {
      tenantId: 1,
      email: "e@x.com",
      role: "admin",
    });

    const [first, second] = fetchMock.mock.calls.map(
      (call) => (call[1]?.headers as Record<string, string>)["x-request-id"],
    );
    expect(first).toMatch(/^server2-knora-bridge-[0-9a-f]{28}$/);
    expect(second).not.toBe(first);
  });
});

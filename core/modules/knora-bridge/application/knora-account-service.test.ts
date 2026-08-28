/**
 * KnoraAccountService 单元测试（characterization）。
 * 边界打桩：全局 fetch（knora-http 与 /auth/me 均直接使用全局 fetch）、
 * Drizzle 数据库（构造函数注入的 NodePgDatabase 用最小链式假件替身）、
 * SecretBox 使用真实 AES-256-GCM 实现。
 * 覆盖：合成密码注册/登录一致性、令牌缓存命中与过期重登、注册冲突引导、
 * 一次性绑定、knora_user_id 兜底解析、错误分类（网络 vs 认证 vs 引导）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import type { AuthenticatedUser } from "../../identity/application/identity-service.js";
import {
  KnoraAccountService,
  KnoraBootstrapRequiredError,
} from "./knora-account-service.js";
import { KnoraHttpError } from "./knora-http.js";
import { makeSecretBox } from "./secret-box.js";

type KnoraAccountRow = typeof schema.knoraAccounts.$inferSelect;
type Route = (init: RequestInit) => Response | Promise<Response>;

const TENANT_ID = 7;
const EMAIL_DOMAIN = "weflow.example";
const UPSTREAM = {
  baseUrl: "http://weknora.test/api/v1",
  apiKey: "tenant-api-key",
  timeoutMs: 1_000,
};
const CACHE_TTL_MS = 22 * 60 * 60 * 1_000;
const BOX = makeSecretBox("test-enc-key");

function makeUser(overrides?: Partial<AuthenticatedUser>): AuthenticatedUser {
  return {
    userId: "u-1",
    username: "alice",
    role: "operator",
    mustChangePassword: false,
    avatarUrl: null,
    avatarPreset: null,
    displayName: null,
    tags: [],
    ...overrides,
  };
}

/** noUncheckedIndexedAccess 友好的首行取值 */
function firstRow(rows: KnoraAccountRow[]): KnoraAccountRow {
  const row = rows[0];
  if (!row) throw new Error("expected a persisted knora_accounts row");
  return row;
}

/** RequestInit.body 安全读取（避免 no-base-to-string 的 String(obj)） */
function parseBody(body: unknown): unknown {
  if (typeof body === "string") return JSON.parse(body);
  expect(body).toBeDefined();
  return JSON.parse(JSON.stringify(body));
}

function seedAccount(
  overrides: Partial<KnoraAccountRow> & Pick<KnoraAccountRow, "weflowUserId">,
): KnoraAccountRow {
  const now = new Date();
  return {
    knoraUserId: "knora-existing",
    knoraEmail: `alice@${EMAIL_DOMAIN}`,
    passwordEnc: BOX.encrypt("synthetic-pw"),
    accessTokenEnc: null,
    refreshTokenEnc: null,
    tokensExpireAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 最小 Drizzle 假件：仅实现服务用到的 select/insert/update 链；单用户场景 */
function makeDb(seed: KnoraAccountRow[] = []) {
  const state = {
    rows: [...seed],
    inserts: [] as KnoraAccountRow[],
    upsertSets: [] as Array<Partial<KnoraAccountRow>>,
    updateSets: [] as Array<Partial<KnoraAccountRow>>,
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.rows.slice(0, 1)),
        }),
      }),
    }),
    insert: () => ({
      values: (values: KnoraAccountRow) => ({
        onConflictDoUpdate: (_conflict: unknown) => {
          state.inserts.push(values);
          const set = (
            _conflict as { set?: Partial<KnoraAccountRow> } | undefined
          )?.set;
          if (set) state.upsertSets.push(set);
          const existing = state.rows.findIndex(
            (row) => row.weflowUserId === values.weflowUserId,
          );
          const merged: KnoraAccountRow = {
            ...(existing >= 0 ? state.rows[existing] : {}),
            ...values,
            ...(set ?? {}),
          };
          if (existing >= 0) state.rows[existing] = merged;
          else state.rows.push(merged);
          return Promise.resolve();
        },
      }),
    }),
    update: () => ({
      set: (set: Partial<KnoraAccountRow>) => ({
        where: () => {
          state.updateSets.push(set);
          if (state.rows[0]) state.rows[0] = { ...state.rows[0], ...set };
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db: db as unknown as NodePgDatabase<typeof schema>, state };
}

/** 全局 fetch 路由桩：未声明的路径一律抛错（fail closed），便于断言“没有多余请求” */
function stubKnoraFetch(routes: Record<string, Route>) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url =
        typeof input === "string" || input instanceof URL
          ? new URL(input)
          : new URL(input.url);
      const path = url.pathname;
      calls.push({ path, init: init ?? {} });
      const route = routes[path];
      if (!route) throw new Error(`unexpected knora request: ${path}`);
      return route(init ?? {});
    }),
  );
  return calls;
}

const loginResponse = (token: string) =>
  Response.json({
    token,
    refresh_token: `refresh-${token}`,
    user: { id: `knora-for-${token}` },
    active_tenant: { id: TENANT_ID },
    memberships: [{ tenant_id: TENANT_ID }],
  });

const meOk = () =>
  Response.json({
    data: {
      user: { id: "me-user", username: "alice" },
      tenant: { name: "共享租户" },
      memberships: [{ role: "contributor" }],
    },
  });

const standardRoutes = (): Record<string, Route> => ({
  "/api/v1/auth/register": () => Response.json({ user: { id: "knora-new" } }),
  "/api/v1/auth/login": () => loginResponse("fresh-tok"),
  "/api/v1/tenants/7/members": () => Response.json({}),
  "/api/v1/auth/me": () => meOk(),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("KnoraAccountService.emailFor", () => {
  const service = new KnoraAccountService(
    makeDb().db,
    UPSTREAM,
    BOX,
    TENANT_ID,
    EMAIL_DOMAIN,
  );

  it("maps ascii usernames to lowercased local part deterministically", () => {
    expect(service.emailFor("  Alice ")).toBe(`alice@${EMAIL_DOMAIN}`);
    expect(service.emailFor("Alice")).toBe(service.emailFor("alice"));
    expect(service.emailFor("ops.lead-1")).toBe(`ops.lead-1@${EMAIL_DOMAIN}`);
  });

  it("falls back to a stable sha256-based local part for non-ascii names", () => {
    const first = service.emailFor("张三");
    expect(first).toMatch(/^u[0-9a-f]{16}@weflow\.example$/);
    expect(service.emailFor("张三")).toBe(first);
    expect(service.emailFor("李四")).not.toBe(first);
  });
});

describe("KnoraAccountService.sessionFor", () => {
  it("registers a new account, logs in with the same synthetic password, persists encrypted credentials, and builds the payload", async () => {
    const { db, state } = makeDb();
    const calls = stubKnoraFetch(standardRoutes());
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );

    const startedAt = Date.now();
    const payload = await service.sessionFor(makeUser());

    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/auth/register",
      "/api/v1/auth/login",
      "/api/v1/tenants/7/members",
      "/api/v1/auth/me",
    ]);
    const registerBody = parseBody(calls[0]?.init.body) as {
      username: string;
      email: string;
      password: string;
    };
    const loginBody = parseBody(calls[1]?.init.body) as {
      email: string;
      password: string;
    };
    expect(registerBody.username).toBe("alice");
    expect(registerBody.email).toBe(`alice@${EMAIL_DOMAIN}`);
    // 注册与登录必须使用同一个合成密码，且持久化后可解回
    expect(loginBody.password).toBe(registerBody.password);
    const memberHeaders = calls[2]?.init.headers as Record<string, string>;
    expect(memberHeaders["x-api-key"]).toBe("tenant-api-key");
    expect(parseBody(calls[2]?.init.body)).toEqual({
      email: `alice@${EMAIL_DOMAIN}`,
      role: "contributor",
    });
    // /auth/me 使用刚登录的访问令牌
    expect(
      (calls[3]?.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer fresh-tok");

    expect(payload).toMatchObject({
      token: "fresh-tok",
      refresh_token: "refresh-fresh-tok",
      selected_tenant_id: String(TENANT_ID),
      selected_tenant_name: "共享租户",
    });
    expect(payload.user).toMatchObject({ id: "me-user" });

    expect(state.rows).toHaveLength(1);
    const row = firstRow(state.rows);
    expect(row.knoraEmail).toBe(`alice@${EMAIL_DOMAIN}`);
    expect(BOX.decrypt(row.passwordEnc)).toBe(registerBody.password);
    expect(BOX.decrypt(row.accessTokenEnc ?? "")).toBe("fresh-tok");
    expect(BOX.decrypt(row.refreshTokenEnc ?? "")).toBe("refresh-fresh-tok");
    expect(row.tokensExpireAt?.getTime()).toBeGreaterThanOrEqual(
      startedAt + CACHE_TTL_MS - 2_000,
    );
    expect(row.tokensExpireAt?.getTime()).toBeLessThanOrEqual(
      Date.now() + CACHE_TTL_MS,
    );
  });

  it("maps the weflow admin role to the WeKnora admin member role", async () => {
    const { db } = makeDb();
    const calls = stubKnoraFetch(standardRoutes());
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );
    await service.sessionFor(makeUser({ role: "admin" }));
    expect(parseBody(calls[2]?.init.body)).toMatchObject({ role: "admin" });
  });

  it("serves a warm cache within TTL without any upstream auth calls", async () => {
    const account = seedAccount({
      weflowUserId: "u-1",
      accessTokenEnc: BOX.encrypt("cached-tok"),
      refreshTokenEnc: BOX.encrypt("cached-refresh"),
      tokensExpireAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    const { db, state } = makeDb([account]);
    // 只声明 members/me 路由：若走到 login/register 会因未知路径直接失败
    const calls = stubKnoraFetch({
      "/api/v1/tenants/7/members": () => Response.json({}),
      "/api/v1/auth/me": () => meOk(),
    });
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );

    const payload = await service.sessionFor(makeUser());

    expect(payload.token).toBe("cached-tok");
    expect(payload.refresh_token).toBe("cached-refresh");
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/tenants/7/members",
      "/api/v1/auth/me",
    ]);
    expect(
      (calls[1]?.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer cached-tok");
    expect(state.updateSets).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("re-logs-in with the stored synthetic password once the cache expires and backfills tokens", async () => {
    const account = seedAccount({
      weflowUserId: "u-1",
      accessTokenEnc: BOX.encrypt("stale-tok"),
      refreshTokenEnc: BOX.encrypt("stale-refresh"),
      tokensExpireAt: new Date(Date.now() - 60 * 1_000),
    });
    const { db, state } = makeDb([account]);
    const calls = stubKnoraFetch(standardRoutes());
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );

    const startedAt = Date.now();
    const payload = await service.sessionFor(makeUser());

    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/auth/login",
      "/api/v1/tenants/7/members",
      "/api/v1/auth/me",
    ]);
    expect(parseBody(calls[0]?.init.body)).toEqual({
      email: `alice@${EMAIL_DOMAIN}`,
      password: "synthetic-pw",
    });
    expect(payload.token).toBe("fresh-tok");
    expect(state.updateSets).toHaveLength(1);
    expect(
      BOX.decrypt(
        firstRow(state.updateSets as KnoraAccountRow[]).accessTokenEnc ?? "",
      ),
    ).toBe("fresh-tok");
    const refreshed = firstRow(state.rows);
    expect(
      refreshed.accessTokenEnc && BOX.decrypt(refreshed.accessTokenEnc),
    ).toBe("fresh-tok");
    expect(refreshed.tokensExpireAt?.getTime()).toBeGreaterThan(
      startedAt + CACHE_TTL_MS - 2_000,
    );
    expect(state.inserts).toHaveLength(0);
  });

  it("treats missing cached token fields as expired and refreshes them", async () => {
    const account = seedAccount({ weflowUserId: "u-1" });
    const { db, state } = makeDb([account]);
    const calls = stubKnoraFetch(standardRoutes());
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );

    await expect(service.sessionFor(makeUser())).resolves.toMatchObject({
      token: "fresh-tok",
    });
    expect(calls.map((call) => call.path)).toContain("/api/v1/auth/login");
    expect(BOX.decrypt(firstRow(state.rows).accessTokenEnc ?? "")).toBe(
      "fresh-tok",
    );
  });

  it("registers each weflow user exactly once (idempotent re-entry)", async () => {
    const { db } = makeDb();
    const calls = stubKnoraFetch(standardRoutes());
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );

    const first = await service.sessionFor(makeUser());
    const second = await service.sessionFor(makeUser());

    expect(second.token).toBe(first.token);
    expect(second.token).toBe("fresh-tok");
    expect(calls.filter((c) => c.path.endsWith("/auth/register"))).toHaveLength(
      1,
    );
  });

  it("throws KnoraBootstrapRequiredError when registration conflicts with an existing WeKnora account", async () => {
    const { db, state } = makeDb();
    stubKnoraFetch({
      ...standardRoutes(),
      "/api/v1/auth/register": () =>
        new Response(
          JSON.stringify({ error: { message: "邮箱已存在", code: 40007 } }),
          {
            status: 409,
          },
        ),
    });
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );

    const error = await service
      .sessionFor(makeUser({ username: "legacy" }))
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(KnoraBootstrapRequiredError);
    expect(error).toMatchObject({
      name: "KnoraBootstrapRequiredError",
      expectedEmail: `legacy@${EMAIL_DOMAIN}`,
    });
    // 冲突时不落库
    expect(state.rows).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("uses a fresh random synthetic password for every registration (not derived from inputs)", async () => {
    const firstCalls = stubKnoraFetch(standardRoutes());
    const first = new KnoraAccountService(
      makeDb().db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );
    await first.sessionFor(makeUser({ userId: "u-a" }));
    const firstPassword = parseBody(firstCalls[0]?.init.body) as {
      password: string;
    };

    vi.unstubAllGlobals();
    const secondCalls = stubKnoraFetch(standardRoutes());
    const second = new KnoraAccountService(
      makeDb().db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );
    await second.sessionFor(makeUser({ userId: "u-b" }));
    const secondPassword = parseBody(secondCalls[0]?.init.body) as {
      password: string;
    };

    expect(firstPassword.password).toBeTruthy();
    expect(secondPassword.password).not.toBe(firstPassword.password);
  });

  it("propagates transport failures during re-login as KnoraHttpError status 0 (distinct from bootstrap)", async () => {
    const account = seedAccount({
      weflowUserId: "u-1",
      accessTokenEnc: BOX.encrypt("stale-tok"),
      tokensExpireAt: new Date(Date.now() - 60 * 1_000),
    });
    const { db, state } = makeDb([account]);
    stubKnoraFetch({
      "/api/v1/auth/login": () => {
        throw new TypeError("fetch failed");
      },
      "/api/v1/tenants/7/members": () => Response.json({}),
      "/api/v1/auth/me": () => meOk(),
    });
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );

    await expect(service.sessionFor(makeUser())).rejects.toMatchObject({
      name: "KnoraHttpError",
      status: 0,
      message: "fetch failed",
    });
    expect(state.updateSets).toHaveLength(0);
  });

  it("degrades gracefully when /auth/me fails and falls back to the login payload", async () => {
    const { db } = makeDb();
    stubKnoraFetch({
      ...standardRoutes(),
      "/api/v1/auth/me": () => new Response("boom", { status: 500 }),
    });
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );

    const payload = await service.sessionFor(makeUser());
    expect(payload.user).toEqual({ id: "knora-for-fresh-tok" });
    expect(payload.active_tenant).toBeUndefined();
    expect(payload.memberships).toEqual([{ tenant_id: TENANT_ID }]);
    expect(payload.selected_tenant_name).toBe("Workspace");
    expect(payload.selected_tenant_id).toBe(String(TENANT_ID));
  });
});

describe("KnoraAccountService.bootstrap", () => {
  const bootstrapRoutes = (): Record<string, Route> => ({
    "/api/v1/auth/login": () => loginResponse("bound-tok"),
    "/api/v1/tenants/7/members": () => Response.json({}),
    "/api/v1/auth/me": () => meOk(),
  });

  it("binds an existing account with the user-provided password and persists managed credentials", async () => {
    const { db, state } = makeDb();
    const calls = stubKnoraFetch(bootstrapRoutes());
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );

    const payload = await service.bootstrap(makeUser(), "manual-password");

    expect(parseBody(calls[0]?.init.body)).toEqual({
      email: `alice@${EMAIL_DOMAIN}`,
      password: "manual-password",
    });
    expect(payload.token).toBe("bound-tok");
    const row = firstRow(state.rows);
    expect(BOX.decrypt(row.passwordEnc)).toBe("manual-password");
    expect(BOX.decrypt(row.accessTokenEnc ?? "")).toBe("bound-tok");

    // 绑定后再次进入会话走缓存，不再触发注册/登录
    const callsBefore = calls.length;
    const again = await service.sessionFor(makeUser());
    expect(again.token).toBe("bound-tok");
    expect(
      calls
        .slice(callsBefore)
        .some(
          (call) =>
            call.path.endsWith("/auth/login") ||
            call.path.endsWith("/auth/register"),
        ),
    ).toBe(false);
  });

  it("propagates wrong-password failures as KnoraHttpError 401 for the route to map", async () => {
    const { db, state } = makeDb();
    stubKnoraFetch({
      "/api/v1/auth/login": () =>
        new Response(
          JSON.stringify({
            error: { message: "bad credentials", code: 40004 },
          }),
          {
            status: 401,
          },
        ),
    });
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );

    await expect(service.bootstrap(makeUser(), "wrong")).rejects.toMatchObject({
      name: "KnoraHttpError",
      status: 401,
      message: "bad credentials",
    });
    expect(state.rows).toHaveLength(0);
  });
});

describe("KnoraAccountService knoraUserId resolution", () => {
  function jwtWithUserId(userId: string): string {
    const payload = Buffer.from(JSON.stringify({ user_id: userId })).toString(
      "base64url",
    );
    return `hdr.${payload}.sig`;
  }

  it("prefers the JWT claim when the login response user lacks an id", async () => {
    const { db, state } = makeDb();
    stubKnoraFetch({
      "/api/v1/auth/login": () =>
        Response.json({
          token: jwtWithUserId("knora-from-jwt"),
          refresh_token: "r",
          user: {},
          active_tenant: null,
          memberships: [],
        }),
      "/api/v1/tenants/7/members": () => Response.json({}),
      "/api/v1/auth/me": () => new Response("nope", { status: 404 }),
    });
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );
    await service.bootstrap(makeUser(), "pw");
    expect(firstRow(state.rows).knoraUserId).toBe("knora-from-jwt");
  });

  it("records 'unknown' when neither the user object nor the token yields an id", async () => {
    const { db, state } = makeDb();
    stubKnoraFetch({
      "/api/v1/auth/login": () =>
        Response.json({
          token: "opaque-token",
          refresh_token: "r",
          user: {},
          active_tenant: null,
          memberships: [],
        }),
      "/api/v1/tenants/7/members": () => Response.json({}),
      "/api/v1/auth/me": () => new Response("nope", { status: 404 }),
    });
    const service = new KnoraAccountService(
      db,
      UPSTREAM,
      BOX,
      TENANT_ID,
      EMAIL_DOMAIN,
    );
    await service.bootstrap(makeUser(), "pw");
    expect(firstRow(state.rows).knoraUserId).toBe("unknown");
  });
});

describe("failure taxonomy", () => {
  it("keeps HTTP auth errors and network errors as distinct KnoraHttpError statuses", () => {
    expect(new KnoraHttpError(401, "bad credentials").status).toBe(401);
    expect(new KnoraHttpError(0, "fetch failed").status).toBe(0);
    expect(
      new KnoraBootstrapRequiredError("bind", "a@x.com").expectedEmail,
    ).toBe("a@x.com");
  });
});

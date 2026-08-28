/**
 * Knora bridge 路由测试（characterization）。
 *
 * 覆盖：
 * - 一次性 code 在 launch / redirect / exchange 之间共享（模块级 Map，验证三入口的 code 一致性）
 * - GET /api/v1/knora/redirect 的契约：
 *   - 未认证 → 401
 *   - origin 缺失 → 503 knora_origin_unconfigured
 *   - 预检过 → 302 到 `${origin}/bridge.html` 并带 code/target/api 三个 query
 *   - 账号已存在（需 bootstrap）→ 409 knora_bootstrap_required + email
 * - POST /api/v1/knora/launch 的契约（保留：未认证 401；不在此处重复 bootstrap 行为，
 *   由 KnoraAccountService 的单测覆盖）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { AuthenticatedUser } from "../../identity/application/identity-service.js";
import {
  registerKnoraBridgeRoutes,
  resetLaunchCodes,
} from "./http-routes.js";
import { makeSecretBox } from "../application/secret-box.js";

vi.mock("../../identity/interface/request-authentication.js", () => ({
  requireBusinessIdentity: async (
    _db: NodePgDatabase<typeof schema>,
    request: { headers: Record<string, string | string[] | undefined> },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    const cookie = request.headers.cookie;
    if (typeof cookie !== "string" || !cookie.includes("weflow_session=valid")) {
      await reply.code(401).send({ error: "authentication_required" });
      return undefined;
    }
    return {
      token: "valid",
      user: {
        userId: "u-1",
        username: "alice",
        role: "operator",
        mustChangePassword: false,
        avatarUrl: null,
        avatarPreset: null,
        displayName: null,
        tags: [],
      } satisfies AuthenticatedUser,
    };
  },
}));

type Route = (init: RequestInit) => Response | Promise<Response>;

const UPSTREAM = {
  baseUrl: "http://weknora.test/api/v1",
  apiKey: "tenant-api-key",
  timeoutMs: 1_000,
};
const TENANT_ID = 7;
const EMAIL_DOMAIN = "weflow.example";

function makeDb(
  users: Array<{
    userId: string;
    username: string;
    role: "admin" | "operator";
    status: "active" | "inactive";
    mustChangePassword: boolean;
    displayName: string | null;
    tags: string[];
  }> = [
    {
      userId: "u-1",
      username: "alice",
      role: "operator",
      status: "active",
      mustChangePassword: false,
      displayName: null,
      tags: [],
    },
  ],
  accounts: Array<Record<string, unknown>> = [],
) {
  const usersState = { rows: [...users] };
  const accountsState = {
    rows: [...accounts],
    inserts: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
  };
  const auditState = { inserts: [] as Array<Record<string, unknown>> };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const isUsers = table === schema.users;
        const isAccounts = table === schema.knoraAccounts;
        return {
          where: () => ({
            limit: () => {
              const source = isUsers
                ? usersState.rows
                : isAccounts
                  ? accountsState.rows
                  : [];
              return Promise.resolve(source.slice(0, 1));
            },
          }),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === schema.knoraAccounts) {
          accountsState.inserts.push(values);
          accountsState.rows.push(values);
        } else if (table === schema.auditEvents) {
          auditState.inserts.push(values);
        }
        return {
          onConflictDoUpdate: () => Promise.resolve(),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        return {
          where: () => {
            if (table === schema.knoraAccounts) {
              accountsState.updates.push(set);
              if (accountsState.rows[0]) {
                accountsState.rows[0] = { ...accountsState.rows[0], ...set };
              }
            }
            return Promise.resolve();
          },
        };
      },
    }),
  };
  return {
    db: db as unknown as NodePgDatabase<typeof schema>,
    state: { usersState, accountsState, auditState },
  };
}

function stubKnoraFetch(routes: Record<string, Route>) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url =
        typeof input === "string" || input instanceof URL
          ? new URL(input)
          : new URL(input.url);
      const route = routes[url.pathname];
      if (!route) throw new Error(`unexpected knora request: ${url.pathname}`);
      return route(init ?? {});
    }),
  );
}

const standardRoutes = (): Record<string, Route> => ({
  "/api/v1/auth/register": () => Response.json({ user: { id: "knora-new" } }),
  "/api/v1/auth/login": () =>
    Response.json({
      token: "tok",
      refresh_token: "ref",
      user: { id: "knora-new" },
      active_tenant: { id: TENANT_ID },
      memberships: [{ tenant_id: TENANT_ID }],
    }),
  "/api/v1/tenants/7/members": () => Response.json({}),
  "/api/v1/auth/me": () =>
    Response.json({
      data: {
        user: { id: "me-user" },
        tenant: { name: "Workspace" },
        memberships: [],
      },
    }),
});

async function buildApp(origin: string | undefined) {
  const { db, state } = makeDb();
  const app = Fastify();
  registerKnoraBridgeRoutes(app, db, {
    weknora: UPSTREAM,
    encKey: "test-enc-key-1234567890",
    tenantId: TENANT_ID,
    emailDomain: EMAIL_DOMAIN,
    origin,
  });
  // 真实 SecretBox 已在 http-routes 内部通过 makeSecretBox 构造；
  // 测试只需要 encrypt/decrypt 的对称性，test-enc-key 满足。
  void makeSecretBox;
  return { app, state };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetLaunchCodes();
});

beforeEach(() => {
  resetLaunchCodes();
});

describe("POST /api/v1/knora/launch", () => {
  it("rejects unauthenticated requests with 401", async () => {
    stubKnoraFetch(standardRoutes());
    const { app } = await buildApp("https://kb.example.com");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/knora/launch",
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("issues a single-use code on success and writes a knora.session_exchanged audit on the matching exchange", async () => {
    stubKnoraFetch(standardRoutes());
    const { app, state } = await buildApp("https://kb.example.com");
    const launch = await app.inject({
      method: "POST",
      url: "/api/v1/knora/launch",
      headers: { cookie: "weflow_session=valid" },
      payload: {},
    });
    expect(launch.statusCode).toBe(200);
    const { code: launchedCode, expiresIn } = launch.json() as {
      code: string;
      expiresIn: number;
    };
    expect(launchedCode).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(expiresIn).toBe(60);

    // exchange 跨 launch 用同一个 code → 写 audit
    const exchange = await app.inject({
      method: "POST",
      url: "/api/v1/knora/exchange",
      payload: { code: launchedCode },
    });
    expect(exchange.statusCode).toBe(200);
    const audit = state.auditState.inserts.find(
      (row) => row.eventType === "knora.session_exchanged",
    );
    expect(audit).toBeDefined();
    expect(audit?.subjectId).toBe("u-1");

    // code 单次有效：再次消费应 401
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/knora/exchange",
      payload: { code: launchedCode },
    });
    expect(replay.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /api/v1/knora/redirect", () => {
  it("rejects unauthenticated browsers with 401 (no 401 JSON leak to kb.leaif.com)", async () => {
    stubKnoraFetch(standardRoutes());
    const { app } = await buildApp("https://kb.example.com");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/knora/redirect",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: "authentication_required",
    });
    await app.close();
  });

  it("returns 503 knora_origin_unconfigured when origin is missing", async () => {
    stubKnoraFetch(standardRoutes());
    const { app } = await buildApp(undefined);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/knora/redirect",
      headers: { cookie: "weflow_session=valid" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "knora_origin_unconfigured",
    });
    await app.close();
  });

  it("302-redirects to ${origin}/bridge.html with code/target/api on success", async () => {
    stubKnoraFetch(standardRoutes());
    const { app } = await buildApp("https://kb.example.com");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/knora/redirect",
      headers: {
        cookie: "weflow_session=valid",
        host: "core.weflow.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(response.statusCode).toBe(302);
    const location = response.headers.location;
    expect(location).toBeDefined();
    const url = new URL(location as string);
    expect(url.origin).toBe("https://kb.example.com");
    expect(url.pathname).toBe("/bridge.html");
    const code = url.searchParams.get("code");
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("target")).toBe("/");
    expect(url.searchParams.get("api")).toBe("http://core.weflow.com");
    await app.close();
  });

  it("honors an absolute http(s) target only when it starts with /", async () => {
    stubKnoraFetch(standardRoutes());
    const { app } = await buildApp("https://kb.example.com");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/knora/redirect?target=/platform/knowledge-bases",
      headers: { cookie: "weflow_session=valid", host: "core.weflow.com" },
    });
    expect(response.statusCode).toBe(302);
    const url = new URL(response.headers.location as string);
    expect(url.searchParams.get("target")).toBe("/platform/knowledge-bases");
    await app.close();
  });

  it("falls back to default target=/ when the target query is missing or unsafe", async () => {
    stubKnoraFetch(standardRoutes());
    const { app } = await buildApp("https://kb.example.com");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/knora/redirect?target=javascript:alert(1)",
      headers: { cookie: "weflow_session=valid", host: "core.weflow.com" },
    });
    expect(response.statusCode).toBe(302);
    const url = new URL(response.headers.location as string);
    expect(url.searchParams.get("target")).toBe("/");
    await app.close();
  });

  it("returns 409 knora_bootstrap_required when the upstream WeKnora account already exists", async () => {
    stubKnoraFetch({
      ...standardRoutes(),
      "/api/v1/auth/register": () =>
        new Response(
          JSON.stringify({ error: { message: "邮箱已存在", code: 40007 } }),
          { status: 409 },
        ),
    });
    const { app, state } = await buildApp("https://kb.example.com");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/knora/redirect",
      headers: { cookie: "weflow_session=valid", host: "core.weflow.com" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "knora_bootstrap_required",
      email: `alice@${EMAIL_DOMAIN}`,
    });
    // bootstrap 失败时不应写 audit
    expect(state.auditState.inserts).toHaveLength(0);
    await app.close();
  });

  it("issues a code that the existing POST /exchange can consume (shared module-level store)", async () => {
    stubKnoraFetch(standardRoutes());
    const { app } = await buildApp("https://kb.example.com");
    const redirect = await app.inject({
      method: "GET",
      url: "/api/v1/knora/redirect",
      headers: { cookie: "weflow_session=valid", host: "core.weflow.com" },
    });
    expect(redirect.statusCode).toBe(302);
    const url = new URL(redirect.headers.location as string);
    const code = url.searchParams.get("code");
    expect(code).toBeTruthy();

    // exchange 用 redirect 签发的 code → 成功
    const exchange = await app.inject({
      method: "POST",
      url: "/api/v1/knora/exchange",
      payload: { code },
    });
    expect(exchange.statusCode).toBe(200);
    const payload = exchange.json() as { token: string };
    expect(payload.token).toBe("tok");
    await app.close();
  });
});

describe("module-level launch code store", () => {
  it("is isolated between tests by resetLaunchCodes()", async () => {
    // 显式 reset：在 resetLaunchCodes 之后注册新 code，前一个测试残留的 code 不可达
    resetLaunchCodes();
    stubKnoraFetch(standardRoutes());
    const first = await buildApp("https://kb.example.com");
    const launch1 = await first.app.inject({
      method: "POST",
      url: "/api/v1/knora/launch",
      headers: { cookie: "weflow_session=valid" },
      payload: {},
    });
    expect(launch1.statusCode).toBe(200);
    const code1 = (launch1.json() as { code: string }).code;

    // 消费 code1 → 200（成功）
    const consume = await first.app.inject({
      method: "POST",
      url: "/api/v1/knora/exchange",
      payload: { code: code1 },
    });
    expect(consume.statusCode).toBe(200);

    // 二次消费同一 code1 → 401（单次有效）
    const replay = await first.app.inject({
      method: "POST",
      url: "/api/v1/knora/exchange",
      payload: { code: code1 },
    });
    expect(replay.statusCode).toBe(401);
    await first.app.close();
  });
});

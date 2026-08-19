/**
 * 联系人头像端点集成测试
 * 验证：鉴权 401、无头像/非白名单 URL → 404、上游成功 → 图片字节
 * 与缓存头、上游 404 → 404、上游 5xx → 502。
 */
import Fastify, {
  type FastifyInstance,
  type LightMyRequestResponse,
} from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { registerIdentityRoutes } from "../modules/identity/interface/http-routes.js";
import { createClosedUser } from "../modules/identity/application/identity-service.js";
import { AvatarProxyService } from "../modules/contacts/application/avatar-proxy-service.js";
import { registerContactAvatarRoutes } from "../modules/contacts/interface/avatar-routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("contact avatar endpoint", () => {
  let postgres: Postgres;
  let server: FastifyInstance;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const cookieHolder: { cookie: string } = { cookie: "" };
  const upstream = vi.fn<typeof globalThis.fetch>();

  const contactIds: string[] = [];

  /** 直接插入一条 contactProfiles，avatarUrl 可指定 */
  async function seedContact(
    id: string,
    avatarUrl: string | null,
  ): Promise<void> {
    contactIds.push(id);
    await postgres.db.insert(schema.contactProfiles).values({
      contactId: id,
      channel: "channel",
      channelContactId: `avatar-${id}-${suffix}`,
      avatarUrl,
    });
  }

  async function getAvatar(
    contactId: string,
    cookie = cookieHolder.cookie,
  ): Promise<LightMyRequestResponse> {
    return server.inject({
      method: "GET",
      url: `/api/v1/contacts/${encodeURIComponent(contactId)}/avatar`,
      headers: cookie ? { cookie } : {},
    });
  }

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "avatar-test"),
    );
    server = Fastify();
    registerIdentityRoutes(server, postgres.db);
    registerContactAvatarRoutes(
      server,
      postgres.db,
      new AvatarProxyService({
        fetch: upstream,
        allowedHosts: ["example-cdn.com"],
      }),
    );
    await server.ready();

    // 登录并改密，拿到业务身份 cookie
    const user = await createClosedUser(
      postgres.db,
      `avatar-${suffix}`,
      "Avatar-pass-1!",
    );
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: user.username, password: "Avatar-pass-1!" },
    });
    const cookie =
      (login.headers["set-cookie"] as unknown as string).split(";")[0] ?? "";
    expect(cookie).toBeTruthy();
    const changed = await server.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: {
        currentPassword: "Avatar-pass-1!",
        newPassword: "Avatar-pass-2!",
      },
    });
    expect(changed.statusCode).toBe(200);
    cookieHolder.cookie = cookie;
  });

  afterAll(async () => {
    for (const contactId of contactIds) {
      await postgres.db
        .delete(schema.contactProfiles)
        .where(eq(schema.contactProfiles.contactId, contactId));
    }
    await server.close();
    await postgres.close();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const contactId = `contact:channel:noauth-${suffix}`;
    await seedContact(contactId, "http://example-cdn.com/a.jpg");
    // 显式不带 cookie：即使 beforeAll 已登录，未认证请求也必须被拒绝
    const response = await getAvatar(contactId, "");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "authentication_required" });
  });

  it("returns 404 for an unknown contact", async () => {
    const response = await getAvatar(`contact:channel:ghost-${suffix}`);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "avatar_not_found" });
  });

  it("returns 404 when the contact has no avatar URL", async () => {
    const contactId = `contact:channel:noavatar-${suffix}`;
    await seedContact(contactId, null);
    const response = await getAvatar(contactId);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "avatar_not_found" });
  });

  it("returns 404 when the stored URL is not on the whitelist", async () => {
    const contactId = `contact:channel:evil-${suffix}`;
    await seedContact(contactId, "https://evil.example.com/avatar.jpg");
    const response = await getAvatar(contactId);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "avatar_not_found" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("proxies a whitelisted avatar and sets cache headers", async () => {
    const contactId = `contact:channel:ok-${suffix}`;
    await seedContact(contactId, "http://example-cdn.com/mmopen/test/132");
    upstream.mockResolvedValue(
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    const response = await getAvatar(contactId);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.headers["cache-control"]).toBe("private, max-age=3600");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(response.rawPayload.subarray(0, 4))).toEqual(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    );
    expect(upstream).toHaveBeenCalledWith(
      "http://example-cdn.com/mmopen/test/132",
      expect.objectContaining({ redirect: "follow" }),
    );
  });

  it("returns 404 when the upstream avatar URL expired", async () => {
    const contactId = `contact:channel:expired-${suffix}`;
    await seedContact(contactId, "http://example-cdn.com/mmopen/gone/132");
    upstream.mockResolvedValue(new Response(null, { status: 404 }));
    const response = await getAvatar(contactId);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "avatar_not_found" });
  });

  it("returns 502 when the upstream fails", async () => {
    const contactId = `contact:channel:upstream-fail-${suffix}`;
    await seedContact(contactId, "http://example-cdn.com/mmopen/fail/132");
    upstream.mockResolvedValue(new Response(null, { status: 500 }));
    const response = await getAvatar(contactId);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "avatar_upstream_failed" });
  });
});

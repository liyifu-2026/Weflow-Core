import Fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { createClosedUser } from "../modules/identity/application/identity-service.js";
import { registerIdentityRoutes } from "../modules/identity/interface/http-routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("信息名片资料（identity profile）", () => {
  let postgres: Postgres;
  let server: FastifyInstance;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const password = "Profile-contract-1!";
  const nextPassword = "Profile-contract-2!";
  const username = `profile-${suffix}`;
  let userId = "";
  let cookie = "";

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "agent-profile-test"),
    );
    server = Fastify();
    registerIdentityRoutes(server, postgres.db);
    await server.ready();
    const created = await createClosedUser(postgres.db, username, password);
    userId = created.userId;
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password },
    });
    const setCookie = login.headers["set-cookie"];
    if (typeof setCookie !== "string") throw new Error("missing cookie");
    cookie = setCookie.split(";")[0] ?? "";
    const changed = await server.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: password, newPassword: nextPassword },
    });
    if (changed.statusCode !== 200) throw new Error("password change failed");
  });

  afterAll(async () => {
    await server.close();
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.actorUserId, userId));
    await postgres.db
      .delete(schema.userSessions)
      .where(eq(schema.userSessions.userId, userId));
    await postgres.db
      .delete(schema.users)
      .where(eq(schema.users.userId, userId));
    await postgres.close();
  });

  it("标签词表来自激活状态的专家队列（不含通用兜底队列）", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/auth/tag-vocabulary",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const tags = response.json<{
      tags: Array<{ key: string; displayName: string }>;
    }>().tags;
    const keys = tags.map((tag) => tag.key);
    expect(keys).toContain("device_fault");
    expect(keys).toContain("after_sales");
    expect(keys).not.toContain("general_handoff");
    const deviceFault = tags.find((tag) => tag.key === "device_fault");
    expect(deviceFault?.displayName).toBe("设备故障");
  });

  it("更新显示名与标签后，登录与 /me 投影都带新字段", async () => {
    const update = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/me",
      headers: { cookie },
      payload: { displayName: "射频小王", tags: ["device_fault", "rf"] },
    });
    expect(update.statusCode, update.body).toBe(200);
    const updatedUser = update.json<{
      user: { displayName: string | null; tags: string[] };
    }>().user;
    expect(updatedUser.displayName).toBe("射频小王");
    expect(updatedUser.tags).toEqual(["device_fault", "rf"]);

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(
      me.json<{ user: { displayName: string | null } }>().user.displayName,
    ).toBe("射频小王");

    const relogin = await server.inject({
      method: "POST",
      url: "/api/v1/mobile/auth/login",
      payload: { username, password: nextPassword },
    });
    const mobileUser = relogin.json<{
      user: { displayName: string | null; tags: string[] };
    }>().user;
    expect(mobileUser.displayName).toBe("射频小王");
    expect(mobileUser.tags).toEqual(["device_fault", "rf"]);
  });

  it("标签去重后存储，且超出词表的标签被拒绝", async () => {
    const deduped = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/me",
      headers: { cookie },
      payload: { tags: ["device_fault", "device_fault", "after_sales"] },
    });
    expect(deduped.statusCode).toBe(200);
    expect(deduped.json<{ user: { tags: string[] } }>().user.tags).toEqual([
      "device_fault",
      "after_sales",
    ]);

    const unknown = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/me",
      headers: { cookie },
      payload: { tags: ["made_up_tag"] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ error: string; tag?: string }>().error).toBe(
      "unknown_tag",
    );

    const tooLong = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/me",
      headers: { cookie },
      payload: { displayName: "这".repeat(25) },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("清空显示名与标签（null / 空数组）是合法的", async () => {
    const clear = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/me",
      headers: { cookie },
      payload: { displayName: null, tags: [] },
    });
    expect(clear.statusCode, clear.body).toBe(200);
    const user = clear.json<{
      user: { displayName: string | null; tags: string[] };
    }>().user;
    expect(user.displayName).toBeNull();
    expect(user.tags).toEqual([]);
  });

  it("资料更新写入审计事件 identity.profile_updated", async () => {
    const events = await postgres.db
      .select({ eventType: schema.auditEvents.eventType })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.actorUserId, userId));
    expect(events.map((event) => event.eventType)).toContain(
      "identity.profile_updated",
    );
  });

  it("空请求体被拒绝（至少更新一个字段）", async () => {
    const empty = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/me",
      headers: { cookie },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });
});

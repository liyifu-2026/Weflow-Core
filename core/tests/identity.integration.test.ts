import Fastify from "fastify";
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
const integrationDatabaseUrl = databaseUrl ?? "";
const integration = databaseUrl ? describe : describe.skip;

integration("closed user and session authentication", () => {
  let postgres: Postgres;
  const server = Fastify();
  const username = `phase2-${String(Date.now())}-${String(process.pid)}`;
  const initialPassword = "Initial-test-password-1!";
  let userId: string;

  beforeAll(async () => {
    postgres = createPostgres(
      integrationDatabaseUrl,
      createLogger({ logLevel: "silent" }, "identity-integration-test"),
    );
    const user = await createClosedUser(postgres.db, username, initialPassword);
    userId = user.userId;
    registerIdentityRoutes(server, postgres.db);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.actorUserId, userId));
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, userId));
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, username));
    await postgres.db
      .delete(schema.userSessions)
      .where(eq(schema.userSessions.userId, userId));
    await postgres.db
      .delete(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.userId, userId));
    await postgres.db
      .delete(schema.users)
      .where(eq(schema.users.userId, userId));
    await postgres.close();
  });

  it("forces first password change and revokes the opaque session on logout", async () => {
    const rejected = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "wrong-password" },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: "invalid_credentials" });

    const loggedIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: username.toUpperCase(), password: initialPassword },
    });
    expect(loggedIn.statusCode).toBe(200);
    expect(loggedIn.json()).toMatchObject({
      user: { username, mustChangePassword: true },
    });
    const setCookie = loggedIn.headers["set-cookie"];
    if (typeof setCookie !== "string")
      throw new Error("missing session cookie");
    expect(setCookie).toContain("HttpOnly");
    // Secure 仅在 NODE_ENV=production 时设置(本地 HTTP 开发不强制)
    if (process.env.NODE_ENV === "production") {
      expect(setCookie).toContain("Secure");
    }
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";")[0];
    if (!cookie) throw new Error("missing cookie value");
    const token = cookie.slice(cookie.indexOf("=") + 1);

    const sessions = await postgres.db
      .select()
      .from(schema.userSessions)
      .where(eq(schema.userSessions.userId, userId));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenDigest).not.toBe(token);
    expect(sessions[0]?.tokenDigest).toMatch(/^[a-f0-9]{64}$/);

    const meBeforeChange = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(meBeforeChange.statusCode).toBe(200);

    const changed = await server.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: {
        currentPassword: initialPassword,
        newPassword: "Replacement-test-password-2!",
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      user: { username, mustChangePassword: false },
    });

    const loggedOut = await server.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie },
    });
    expect(loggedOut.statusCode).toBe(204);
    expect(loggedOut.headers["set-cookie"]).toContain("Max-Age=0");

    const meAfterLogout = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(meAfterLogout.statusCode).toBe(401);

    const audits = await postgres.db
      .select({ eventType: schema.auditEvents.eventType })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, userId));
    expect(audits.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "identity.user_created",
        "identity.login_succeeded",
        "identity.password_changed",
        "identity.logout",
      ]),
    );
  });

  it("issues an opaque mobile token without a browser cookie", async () => {
    const mobileUsername = `mobile-${String(Date.now())}-${String(process.pid)}`;
    const mobileUser = await createClosedUser(
      postgres.db,
      mobileUsername,
      initialPassword,
    );
    try {
      const login = await server.inject({
        method: "POST",
        url: "/api/v1/mobile/auth/login",
        payload: { username: mobileUsername, password: initialPassword },
      });
      expect(login.statusCode).toBe(200);
      expect(login.headers["set-cookie"]).toBeUndefined();
      const body = login.json<{
        sessionToken: string;
        user: { userId: string; mustChangePassword: boolean };
      }>();
      expect(body).toMatchObject({
        user: { userId: mobileUser.userId, mustChangePassword: true },
      });
      expect(body.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

      const me = await server.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${body.sessionToken}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ user: { userId: mobileUser.userId } });

      const logout = await server.inject({
        method: "POST",
        url: "/api/v1/mobile/auth/logout",
        headers: { authorization: `Bearer ${body.sessionToken}` },
      });
      expect(logout.statusCode).toBe(204);

      const rejected = await server.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${body.sessionToken}` },
      });
      expect(rejected.statusCode).toBe(401);
    } finally {
      await postgres.db
        .delete(schema.auditEvents)
        .where(eq(schema.auditEvents.actorUserId, mobileUser.userId));
      await postgres.db
        .delete(schema.auditEvents)
        .where(eq(schema.auditEvents.subjectId, mobileUser.userId));
      await postgres.db
        .delete(schema.auditEvents)
        .where(eq(schema.auditEvents.subjectId, mobileUsername));
      await postgres.db
        .delete(schema.userSessions)
        .where(eq(schema.userSessions.userId, mobileUser.userId));
      await postgres.db
        .delete(schema.users)
        .where(eq(schema.users.userId, mobileUser.userId));
    }
  });
});

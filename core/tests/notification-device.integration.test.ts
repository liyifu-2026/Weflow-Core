import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { registerNotificationRoutes } from "../modules/notifications/interface/http-routes.js";
import { createClosedUser } from "../modules/identity/application/identity-service.js";
import { registerIdentityRoutes } from "../modules/identity/interface/http-routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("mobile notification device revocation", () => {
  let postgres: Postgres;
  const server = Fastify();
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const username = `notification-device-${suffix}`;
  const initialPassword = "Initial-notification-password-1!";
  const newPassword = "Replacement-notification-password-2!";
  const pushToken = `ExponentPushToken[notification-device-${suffix}]`;
  let userId: string;
  let cookie: string;

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "notification-device-test"),
    );
    const user = await createClosedUser(postgres.db, username, initialPassword);
    userId = user.userId;
    registerIdentityRoutes(server, postgres.db);
    registerNotificationRoutes(server, postgres.db);
    await server.ready();
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: initialPassword },
    });
    const setCookie = login.headers["set-cookie"];
    if (typeof setCookie !== "string")
      throw new Error("missing session cookie");
    cookie = setCookie.split(";")[0] ?? "";
    const changed = await server.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: initialPassword, newPassword },
    });
    if (changed.statusCode !== 200) throw new Error("password change failed");
  });

  afterAll(async () => {
    await server.close();
    await postgres.db
      .delete(schema.notificationDevices)
      .where(eq(schema.notificationDevices.userId, userId));
    await postgres.db
      .delete(schema.userSessions)
      .where(eq(schema.userSessions.userId, userId));
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.actorUserId, userId));
    await postgres.db
      .delete(schema.users)
      .where(eq(schema.users.userId, userId));
    await postgres.close();
  });

  it("revokes only the requested device token", async () => {
    const registered = await server.inject({
      method: "PUT",
      url: "/api/v1/mobile/notification-device",
      headers: { cookie },
      payload: { pushToken, platform: "android", showPreview: false },
    });
    expect(registered.statusCode).toBe(200);

    const revoked = await server.inject({
      method: "DELETE",
      url: "/api/v1/mobile/notification-device",
      headers: { cookie },
      payload: { pushToken },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ revoked: true });

    const devices = await postgres.db
      .select()
      .from(schema.notificationDevices)
      .where(eq(schema.notificationDevices.pushToken, pushToken));
    expect(devices[0]?.revokedAt).toBeInstanceOf(Date);
  });
});

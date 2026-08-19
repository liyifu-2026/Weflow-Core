/**
 * 通知模块 HTTP 路由
 *
 * 提供移动设备推送注册和通知偏好的 REST API 端点。
 * 设备注册使用 pushToken 作为唯一标识，支持 upsert。
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";

const deviceBody = z
  .object({
    pushToken: z.string().min(20).max(300),
    platform: z.enum(["ios", "android"]),
    showPreview: z.boolean().default(false),
  })
  .strict();
const preferenceBody = z.object({ showPreview: z.boolean() }).strict();

/** 注册通知模块的所有 HTTP 路由 */
export function registerNotificationRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
): void {
  server.put("/api/v1/mobile/notification-device", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    const body = deviceBody.safeParse(request.body);
    if (!identity || !body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const deviceId = randomUUID();
    const devices = await db
      .insert(schema.notificationDevices)
      .values({ deviceId, userId: identity.user.userId, ...body.data })
      .onConflictDoUpdate({
        target: schema.notificationDevices.pushToken,
        set: {
          userId: identity.user.userId,
          platform: body.data.platform,
          showPreview: body.data.showPreview,
          revokedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return { device: devices[0] };
  });
  server.delete(
    "/api/v1/mobile/notification-device",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      const body = z
        .object({ pushToken: deviceBody.shape.pushToken })
        .strict()
        .safeParse(request.body);
      if (!identity || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      await db
        .update(schema.notificationDevices)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.notificationDevices.userId, identity.user.userId),
            eq(schema.notificationDevices.pushToken, body.data.pushToken),
            isNull(schema.notificationDevices.revokedAt),
          ),
        );
      return { revoked: true };
    },
  );
  server.patch(
    "/api/v1/mobile/notification-preferences",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      const body = preferenceBody.safeParse(request.body);
      if (!identity || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      await db
        .update(schema.notificationDevices)
        .set({ showPreview: body.data.showPreview, updatedAt: new Date() })
        .where(
          and(
            eq(schema.notificationDevices.userId, identity.user.userId),
            isNull(schema.notificationDevices.revokedAt),
          ),
        );
      return { showPreview: body.data.showPreview };
    },
  );
}

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
    /** 订阅的通知类型；缺省 = 全部订阅（不改动既有偏好语义） */
    notifyKinds: z
      .array(
        z.enum(["handoff_pending", "handoff_assigned", "assignee_inbound"]),
      )
      .max(8)
      .optional(),
  })
  .strict();
const preferenceBody = z
  .object({
    showPreview: z.boolean().optional(),
    notifyKinds: z
      .array(
        z.enum(["handoff_pending", "handoff_assigned", "assignee_inbound"]),
      )
      .max(8)
      .optional(),
  })
  .refine(
    (value) => value.showPreview !== undefined || value.notifyKinds !== undefined,
    { message: "nothing_to_update" },
  );

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
      .values({
        deviceId,
        userId: identity.user.userId,
        pushToken: body.data.pushToken,
        platform: body.data.platform,
        showPreview: body.data.showPreview,
        // 未传 = 全部订阅（NULL 语义），传空数组也按全部订阅处理
        notifyKinds:
          body.data.notifyKinds && body.data.notifyKinds.length > 0
            ? body.data.notifyKinds
            : null,
      })
      .onConflictDoUpdate({
        target: schema.notificationDevices.pushToken,
        set: {
          userId: identity.user.userId,
          platform: body.data.platform,
          showPreview: body.data.showPreview,
          notifyKinds:
            body.data.notifyKinds && body.data.notifyKinds.length > 0
              ? body.data.notifyKinds
              : null,
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
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.data.showPreview !== undefined)
        updates.showPreview = body.data.showPreview;
      if (body.data.notifyKinds !== undefined)
        // 空数组 = 全部订阅（NULL 语义），与注册接口一致
        updates.notifyKinds =
          body.data.notifyKinds.length > 0 ? body.data.notifyKinds : null;
      await db
        .update(schema.notificationDevices)
        .set(updates)
        .where(
          and(
            eq(schema.notificationDevices.userId, identity.user.userId),
            isNull(schema.notificationDevices.revokedAt),
          ),
        );
      return { showPreview: body.data.showPreview ?? null };
    },
  );
}

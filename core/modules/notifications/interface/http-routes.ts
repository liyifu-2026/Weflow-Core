/**
 * 通知模块 HTTP 路由
 *
 * 提供移动设备推送注册和通知偏好的 REST API 端点。
 * 设备注册使用 pushToken 作为唯一标识，支持 upsert。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BusinessDb } from "../../identity/application/db.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import {
  registerNotificationDevice,
  revokeNotificationDevice,
  updateNotificationPreferences,
} from "../application/notification-device-service.js";

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
    (value) =>
      value.showPreview !== undefined || value.notifyKinds !== undefined,
    { message: "nothing_to_update" },
  );

/** 注册通知模块的所有 HTTP 路由 */
export function registerNotificationRoutes(
  server: FastifyInstance,
  db: BusinessDb,
): void {
  server.put("/api/v1/mobile/notification-device", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    const body = deviceBody.safeParse(request.body);
    if (!identity || !body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const device = await registerNotificationDevice(db, {
      userId: identity.user.userId,
      pushToken: body.data.pushToken,
      platform: body.data.platform,
      showPreview: body.data.showPreview,
      ...(body.data.notifyKinds ? { notifyKinds: body.data.notifyKinds } : {}),
    });
    return { device };
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
      await revokeNotificationDevice(db, {
        userId: identity.user.userId,
        pushToken: body.data.pushToken,
      });
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
      await updateNotificationPreferences(db, {
        userId: identity.user.userId,
        ...(body.data.showPreview !== undefined
          ? { showPreview: body.data.showPreview }
          : {}),
        ...(body.data.notifyKinds !== undefined
          ? { notifyKinds: body.data.notifyKinds }
          : {}),
      });
      return { showPreview: body.data.showPreview ?? null };
    },
  );
}

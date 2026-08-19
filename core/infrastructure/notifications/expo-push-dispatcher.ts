/**
 * Expo 推送通知分发器
 * 定期扫描通知发件箱，通过 Expo Push API 向用户设备发送推送通知
 * 支持通知类型：handoff_pending（等待处理）、handoff_assigned（转交）、新消息
 * 自动处理设备注册失效（DeviceNotRegistered）情况
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../postgres/schema.js";

/** Expo Push API 端点 */
const expoEndpoint = "https://exp.host/--/api/v2/push/send";

/**
 * 启动 Expo 推送通知分发器
 * @param options.db - 数据库实例
 * @param options.intervalMs - 轮询间隔（毫秒），默认 5000
 * @param options.logger - 日志记录器
 * @returns 停止分发器的函数
 */
export function startExpoPushDispatcher(options: {
  db: NodePgDatabase<typeof schema>;
  intervalMs?: number;
  logger: { warn: (value: unknown, message?: string) => void };
}): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await dispatch(options.db);
    } catch (error) {
      options.logger.warn({ err: error }, "Push outbox dispatch failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, options.intervalMs ?? 5_000);
  void tick();
  return () => {
    clearInterval(timer);
  };
}

/** 执行一次推送分发：获取待发送通知并逐个处理 */
async function dispatch(db: NodePgDatabase<typeof schema>): Promise<void> {
  const items = await db
    .select()
    .from(schema.notificationOutbox)
    .where(eq(schema.notificationOutbox.status, "pending"))
    .orderBy(asc(schema.notificationOutbox.createdAt))
    .limit(20);
  for (const item of items) {
    const devices = await db
      .select()
      .from(schema.notificationDevices)
      .where(
        and(
          eq(schema.notificationDevices.userId, item.userId),
          isNull(schema.notificationDevices.revokedAt),
        ),
      );
    if (devices.length === 0) {
      await db
        .update(schema.notificationOutbox)
        .set({ status: "sent", sentAt: new Date() })
        .where(
          eq(schema.notificationOutbox.notificationId, item.notificationId),
        );
      continue;
    }
    try {
      const response = await fetch(expoEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          devices.map((device) => ({
            to: device.pushToken,
            sound: "default",
            title:
              item.kind === "handoff_pending"
                ? "有会话等待处理"
                : item.kind === "handoff_assigned"
                  ? "有会话转给你"
                  : "客户有新消息",
            body: device.showPreview ? "请打开值班台查看" : undefined,
            data: { conversationId: item.conversationId, kind: item.kind },
          })),
        ),
      });
      if (!response.ok) throw new Error(`expo_http_${String(response.status)}`);
      const payload = (await response.json()) as {
        data?: Array<{ status?: string; details?: { error?: string } }>;
      };
      const invalid = devices.filter(
        (_, index) =>
          payload.data?.[index]?.details?.error === "DeviceNotRegistered",
      );
      if (invalid.length)
        await db
          .update(schema.notificationDevices)
          .set({ revokedAt: new Date() })
          .where(
            inArray(
              schema.notificationDevices.deviceId,
              invalid.map((device) => device.deviceId),
            ),
          );
      await db
        .update(schema.notificationOutbox)
        .set({ status: "sent", sentAt: new Date(), attempt: item.attempt + 1 })
        .where(
          eq(schema.notificationOutbox.notificationId, item.notificationId),
        );
    } catch (error) {
      await db
        .update(schema.notificationOutbox)
        .set({
          status: item.attempt >= 4 ? "failed" : "pending",
          attempt: item.attempt + 1,
          errorCode:
            error instanceof Error
              ? error.message.slice(0, 100)
              : "push_failed",
        })
        .where(
          eq(schema.notificationOutbox.notificationId, item.notificationId),
        );
    }
  }
}

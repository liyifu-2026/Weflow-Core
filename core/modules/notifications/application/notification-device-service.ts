/**
 * 移动推送设备注册与通知偏好（application 层）。
 *
 * 设备以 pushToken 为唯一标识 upsert；偏好变更作用于该用户全部
 * 未撤销设备。NULL notifyKinds 语义 = 全部订阅。
 */
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

export type NotifyKind =
  "handoff_pending" | "handoff_assigned" | "assignee_inbound";

export type RegisterDeviceInput = {
  userId: string;
  pushToken: string;
  platform: "ios" | "android";
  showPreview: boolean;
  /** 未传/空数组 = 全部订阅（落 NULL） */
  notifyKinds?: NotifyKind[];
};

export type UpdatePreferencesInput = {
  userId: string;
  showPreview?: boolean;
  notifyKinds?: NotifyKind[];
};

/** 注册/更新推送设备（upsert by pushToken），返回落库后的设备行 */
export async function registerNotificationDevice(
  db: NodePgDatabase<typeof schema>,
  input: RegisterDeviceInput,
) {
  const notifyKinds =
    input.notifyKinds && input.notifyKinds.length > 0
      ? input.notifyKinds
      : null;
  const now = new Date();
  const devices = await db
    .insert(schema.notificationDevices)
    .values({
      deviceId: randomUUID(),
      userId: input.userId,
      pushToken: input.pushToken,
      platform: input.platform,
      showPreview: input.showPreview,
      notifyKinds,
    })
    .onConflictDoUpdate({
      target: schema.notificationDevices.pushToken,
      set: {
        userId: input.userId,
        platform: input.platform,
        showPreview: input.showPreview,
        notifyKinds,
        revokedAt: null,
        updatedAt: now,
      },
    })
    .returning();
  return devices[0];
}

/** 撤销当前用户的指定推送设备 */
export async function revokeNotificationDevice(
  db: NodePgDatabase<typeof schema>,
  input: { userId: string; pushToken: string },
): Promise<void> {
  await db
    .update(schema.notificationDevices)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.notificationDevices.userId, input.userId),
        eq(schema.notificationDevices.pushToken, input.pushToken),
        isNull(schema.notificationDevices.revokedAt),
      ),
    );
}

/** 更新当前用户全部未撤销设备的通知偏好 */
export async function updateNotificationPreferences(
  db: NodePgDatabase<typeof schema>,
  input: UpdatePreferencesInput,
): Promise<void> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.showPreview !== undefined) updates.showPreview = input.showPreview;
  if (input.notifyKinds !== undefined)
    // 空数组 = 全部订阅（NULL 语义），与注册接口一致
    updates.notifyKinds =
      input.notifyKinds.length > 0 ? input.notifyKinds : null;
  await db
    .update(schema.notificationDevices)
    .set(updates)
    .where(
      and(
        eq(schema.notificationDevices.userId, input.userId),
        isNull(schema.notificationDevices.revokedAt),
      ),
    );
}

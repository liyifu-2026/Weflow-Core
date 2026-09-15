/**
 * 通知偏好本地缓存模块
 * 在设备安全区域缓存用户确认的通知预览偏好设置。
 * 按账号隔离，使用 SHA256 哈希生成存储键。
 */
import * as Crypto from "expo-crypto";
import { sensitiveStorage } from "@/storage/sensitive-storage";
import type { ConfirmedPreviewPreference } from "./policy";

const KEY_PREFIX = "weflow.mobile.notification-preference.";

export type ConfirmedNotificationPreference = ConfirmedPreviewPreference;

/** 加载已确认的通知预览偏好，数据校验失败时返回 undefined */
export async function loadConfirmedNotificationPreference(
  accountId: string,
): Promise<ConfirmedNotificationPreference | undefined> {
  try {
    const value = await sensitiveStorage.getItemAsync(await preferenceKey(accountId));
    if (!value) return undefined;
    const parsed = JSON.parse(value) as ConfirmedNotificationPreference;
    if (
      typeof parsed.showPreview !== "boolean" ||
      typeof parsed.confirmedAt !== "string"
    ) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 保存通知预览偏好到安全存储 */
export async function saveConfirmedNotificationPreference(
  accountId: string,
  showPreview: boolean,
): Promise<ConfirmedNotificationPreference> {
  const preference = {
    showPreview,
    confirmedAt: new Date().toISOString(),
  };
  await sensitiveStorage.setItemAsync(
    await preferenceKey(accountId),
    JSON.stringify(preference),
  );
  return preference;
}

async function preferenceKey(accountId: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    accountId,
  );
  return `${KEY_PREFIX}${digest}`;
}

/** 服务端支持的通知类型（与 Core outbox kind 同源） */
export const ALL_NOTIFY_KINDS = [
  "handoff_pending",
  "handoff_assigned",
  "assignee_inbound",
] as const;

export type NotifyKind = (typeof ALL_NOTIFY_KINDS)[number];

const KINDS_KEY_PREFIX = "weflow.mobile.notify-kinds.";

/**
 * 读取本账号的通知类型订阅；undefined = 未配置（服务端默认全部订阅）。
 * 存储数据非法时同样视为未配置，回退服务端默认。
 */
export async function loadNotifyKinds(
  accountId: string,
): Promise<NotifyKind[] | undefined> {
  try {
    const digest = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      accountId,
    );
    const value = await sensitiveStorage.getItemAsync(`${KINDS_KEY_PREFIX}${digest}`);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const kinds = parsed.filter((kind): kind is NotifyKind =>
      (ALL_NOTIFY_KINDS as readonly string[]).includes(kind as string),
    );
    return kinds.length > 0 ? kinds : undefined;
  } catch {
    return undefined;
  }
}

/** 保存本账号的通知类型订阅（空数组按未配置处理，回退全部订阅） */
export async function saveNotifyKinds(
  accountId: string,
  kinds: NotifyKind[],
): Promise<void> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    accountId,
  );
  const value = kinds.length > 0 ? JSON.stringify(kinds) : null;
  const key = `${KINDS_KEY_PREFIX}${digest}`;
  if (value === null) {
    await sensitiveStorage.deleteItemAsync(key);
    return;
  }
  await sensitiveStorage.setItemAsync(key, value);
}

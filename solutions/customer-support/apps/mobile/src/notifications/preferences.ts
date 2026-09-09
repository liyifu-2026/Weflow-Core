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

/**
 * 推送设备注册模块
 * 管理移动端推送通知的设备注册和预览偏好更新。
 * 注册流程：请求系统权限 → 获取 Expo Push Token → 向 Core 注册设备。
 * 仅在 iOS 和 Android 平台执行，Web 平台跳过。
 */
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { request } from "@/api/client";
import type { MobileSession } from "@/auth/session";
import {
  loadConfirmedNotificationPreference,
  saveConfirmedNotificationPreference,
} from "./preferences";
import { registrationPreviewPreference } from "./policy";

// 配置通知在前台时也显示横幅和播放声音
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** 注册当前设备的推送 Token 到 Core */
export async function registerPushDevice(
  session: MobileSession,
): Promise<void> {
  if (Platform.OS !== "android" && Platform.OS !== "ios") return;
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted
    ? current
    : await Notifications.requestPermissionsAsync();
  if (!permission.granted) return;
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("default", {
      name: "人工接管",
      importance: Notifications.AndroidImportance.HIGH,
    });
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as
    string | undefined;
  if (!projectId) throw new Error("expo_project_id_missing");
  const pushToken = (await Notifications.getExpoPushTokenAsync({ projectId }))
    .data;
  const confirmed = await loadConfirmedNotificationPreference(
    session.user.userId,
  );
  const result = await request<{ device: { showPreview: boolean } }>(
    "/api/v1/mobile/notification-device",
    {
      method: "PUT",
      token: session.sessionToken,
      body: JSON.stringify({
        pushToken,
        platform: Platform.OS,
        showPreview: registrationPreviewPreference(confirmed),
      }),
    },
  );
  await saveConfirmedNotificationPreference(
    session.user.userId,
    result.device.showPreview,
  ).catch(() => undefined);
}

/** 撤销当前设备的推送 Token；失败时由调用方决定是否继续退出。 */
export async function unregisterPushDevice(
  session: MobileSession,
): Promise<void> {
  if (Platform.OS !== "android" && Platform.OS !== "ios") return;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as
    string | undefined;
  if (!projectId) return;
  const pushToken = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await request("/api/v1/mobile/notification-device", {
    method: "DELETE",
    token: session.sessionToken,
    body: JSON.stringify({ pushToken }),
  });
}

/** 更新通知消息预览设置（显示/隐藏消息正文） */
export async function updateNotificationPreview(
  session: MobileSession,
  showPreview: boolean,
): Promise<{ showPreview: boolean; cachedLocally: boolean }> {
  const result = await request<{ showPreview: boolean }>(
    "/api/v1/mobile/notification-preferences",
    {
      method: "PATCH",
      token: session.sessionToken,
      body: JSON.stringify({ showPreview }),
    },
  );
  let cachedLocally = true;
  try {
    await saveConfirmedNotificationPreference(
      session.user.userId,
      result.showPreview,
    );
  } catch {
    cachedLocally = false;
  }
  return { showPreview: result.showPreview, cachedLocally };
}

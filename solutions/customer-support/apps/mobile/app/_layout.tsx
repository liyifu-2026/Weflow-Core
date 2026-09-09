/**
 * 应用根布局组件
 * 负责：
 * - 提供安全区域和主题上下文
 * - 监听认证失效事件并跳转登录页
 * - 注册推送设备和监听通知点击事件
 * - 应用切换到后台时显示隐私遮罩（隐藏客户信息）
 * - 设置系统 UI 背景色跟随主题
 */
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import * as SystemUI from "expo-system-ui";
import { useEffect, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { invalidateSession, loadSession } from "@/auth/session";
import { subscribeAuthenticationRequired } from "@/auth/auth-events";
import { registerPushDevice } from "@/notifications/register-device";
import { notifyConversationRefresh } from "@/conversations/sync-store";
import * as Crypto from "expo-crypto";
import { sensitiveStorage } from "@/storage/sensitive-storage";
import { migrateMobileStorageKeys } from "@/storage/mobile-key-migration";
import { ThemeProvider, useTheme, useThemedStyles } from "@/ui/theme-context";
import type { ThemeColors } from "@/ui/theme";

/** 根布局：包裹安全区域和主题提供者 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <RootContent />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** 根内容组件：处理全局初始化和隐私保护 */
function RootContent() {
  const [isProtected, setIsProtected] = useState(AppState.currentState !== "active");
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(createStyles);
  useEffect(() => {
    let handling = false;
    return subscribeAuthenticationRequired(() => {
      if (handling) return;
      handling = true;
      void invalidateSession().finally(() => {
        router.replace("/");
        handling = false;
      });
    });
  }, []);
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.canvas);
  }, [colors.canvas]);
  useEffect(() => {
    void (async () => {
      try {
        await migrateMobileStorageKeys({
          storage: sensitiveStorage,
          digest: (value) =>
            Crypto.digestStringAsync(
              Crypto.CryptoDigestAlgorithm.SHA256,
              value,
            ),
        });
        const session = await loadSession();
        if (session) {
          await migrateMobileStorageKeys(
            {
              storage: sensitiveStorage,
              digest: (value) =>
                Crypto.digestStringAsync(
                  Crypto.CryptoDigestAlgorithm.SHA256,
                  value,
                ),
            },
            session.user.userId,
          );
          void registerPushDevice(session).catch(() => undefined);
        }
      } catch {
        // Migration is retryable and must not prevent the app from opening.
      }
    })();
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const conversationId =
          response.notification.request.content.data?.conversationId;
        if (typeof conversationId === "string")
          notifyConversationRefresh();
        if (typeof conversationId === "string")
          router.push(`/conversation/${conversationId}`);
      },
    );
    const notificationSubscription = Notifications.addNotificationReceivedListener(() => {
      notifyConversationRefresh();
    });
    return () => {
      subscription.remove();
      notificationSubscription.remove();
    };
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setIsProtected(state !== "active");
    });
    return () => subscription.remove();
  }, []);
  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, animation: "fade", contentStyle: { backgroundColor: colors.canvas } }} />
      {isProtected && (
        <View style={styles.privacyShield} pointerEvents="none">
          <Text style={styles.privacyBrand}>Weflow</Text>
          <Text style={styles.privacyText}>客户内容已隐藏</Text>
        </View>
      )}
    </>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  privacyShield: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.canvas, alignItems: "center", justifyContent: "center" },
  privacyBrand: { color: colors.ink, fontSize: 13, fontWeight: "700", letterSpacing: 0.2 },
  privacyText: { color: colors.muted, fontSize: 12, marginTop: 8 },
});

const styles = StyleSheet.create({
  root: { flex: 1 },
});

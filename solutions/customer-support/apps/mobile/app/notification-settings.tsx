/**
 * 通知与隐私设置页面
 * 管理两层独立的通知控制：
 * 1. Server2 预览策略：控制通知中是否显示消息正文（跨设备生效）
 * 2. 系统通知权限：控制是否允许推送通知（仅当前设备）
 * 两者互不影响：关闭系统通知不会修改 Server2 策略，反之亦然。
 */
import { router } from "expo-router";
import * as Notifications from "expo-notifications";
import { ArrowLeft } from "phosphor-react-native/src/icons/ArrowLeft";
import { ShieldCheck } from "phosphor-react-native/src/icons/ShieldCheck";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { loadSession, type MobileSession } from "@/auth/session";
import {
  registerPushDevice,
  updateNotificationPreview,
} from "@/notifications/register-device";
import { loadConfirmedNotificationPreference } from "@/notifications/preferences";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { uiTokens } from "@/ui/tokens";

/** 系统通知权限状态 */
type PermissionState = "granted" | "denied" | "undetermined" | "unsupported";

/** 通知与隐私设置页面组件 */
export default function NotificationSettingsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [session, setSession] = useState<MobileSession>();
  const [showPreview, setShowPreview] = useState(false);
  const [confirmedAt, setConfirmedAt] = useState<string>();
  const [permission, setPermission] = useState<PermissionState>("undetermined");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const storedSession = await loadSession();
      if (!storedSession) {
        router.replace("/");
        return;
      }
      const [confirmed, permissionState] = await Promise.all([
        loadConfirmedNotificationPreference(storedSession.user.userId),
        readPermissionState(),
      ]);
      if (disposed) return;
      setSession(storedSession);
      setShowPreview(confirmed?.showPreview ?? false);
      setConfirmedAt(confirmed?.confirmedAt);
      setPermission(permissionState);
      setLoading(false);
    })().catch(() => {
      if (disposed) return;
      setError("通知设置暂时无法读取，请返回后重试。");
      setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void readPermissionState().then(setPermission).catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);

  async function savePreview(nextValue: boolean) {
    if (!session || saving || nextValue === showPreview) return;
    setSaving(true);
    setError(undefined);
    try {
      const confirmed = await updateNotificationPreview(session, nextValue);
      setShowPreview(confirmed.showPreview);
      setConfirmedAt(new Date().toISOString());
      if (!confirmed.cachedLocally) {
        setError("Server2 已保存设置，但本机无法保存确认记录；下次启动前请再次检查。");
      }
    } catch {
      setError("通知隐私设置没有保存，请检查网络后重试。");
    } finally {
      setSaving(false);
    }
  }

  function choosePreview(nextValue: boolean) {
    if (!nextValue) {
      void savePreview(false);
      return;
    }
    Alert.alert(
      "在通知中显示消息预览？",
      "客户消息可能出现在锁屏和系统通知中心。请确认设备仅由你本人使用。",
      [
        { text: "取消", style: "cancel" },
        { text: "允许预览", onPress: () => void savePreview(true) },
      ],
    );
  }

  async function updateSystemPermission() {
    if (!session || Platform.OS === "web") return;
    if (permission === "denied") {
      await Linking.openSettings();
      return;
    }
    const result = await Notifications.requestPermissionsAsync();
    const nextPermission = permissionStateFromResponse(result);
    setPermission(nextPermission);
    if (result.granted) {
      try {
        await registerPushDevice(session);
      } catch {
        setError("系统已允许通知，但设备暂时无法向 Server2 注册。");
      }
    }
  }

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回" onPress={() => router.back()} hitSlop={12}>
          <ArrowLeft size={23} color={colors.ink} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>通知与隐私</Text>
          <Text style={styles.subtitle}>控制锁屏内容和设备提醒</Text>
        </View>
      </View>
      {loading ? (
        <View style={styles.loading}><ActivityIndicator color={colors.blue} /><Text style={styles.loadingText}>正在读取通知设置</Text></View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.privacyCard}>
            <View style={styles.privacyMark}><ShieldCheck size={21} color={colors.blue} weight="fill" /></View>
            <View style={styles.privacyCopy}>
              <Text style={styles.privacyTitle}>锁屏消息预览</Text>
              <Text style={styles.privacyText}>设置会应用到当前账号的移动设备。</Text>
            </View>
          </View>
          <Text style={styles.sectionLabel}>消息预览</Text>
          <PreferenceOption
            selected={!showPreview}
            title="隐藏消息正文"
            description="通知仅保留联系人和工作状态，适合默认使用。"
            badge="推荐"
            onPress={() => choosePreview(false)}
          />
          <PreferenceOption
            selected={showPreview}
            title="显示消息预览"
            description="锁屏和通知中心可能显示客户发来的内容。"
            tone="warning"
            onPress={() => choosePreview(true)}
          />
          {saving && <View style={styles.savingLine}><ActivityIndicator size="small" color={colors.blue} /><Text style={styles.savingText}>正在同步到 Server2</Text></View>}
          {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          <Text style={styles.confirmedText}>{confirmedAt ? `最近确认 · ${formatConfirmedAt(confirmedAt)}` : "默认采用隐藏消息正文"}</Text>
          <Text style={styles.sectionLabel}>系统通知权限</Text>
          <View style={styles.permissionCard}>
            <View style={styles.permissionCopy}>
              <Text style={styles.permissionTitle}>{permissionTitle(permission)}</Text>
              <Text style={styles.permissionText}>{permissionDescription(permission)}</Text>
            </View>
            {permission !== "granted" && permission !== "unsupported" && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={permission === "denied" ? "打开系统通知设置" : "允许系统通知"}
                onPress={() => void updateSystemPermission()}
                style={styles.permissionButton}
              >
                <Text style={styles.permissionButtonText}>{permission === "denied" ? "打开设置" : "允许通知"}</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function PreferenceOption({
  selected,
  title,
  description,
  badge,
  tone,
  onPress,
}: {
  selected: boolean;
  title: string;
  description: string;
  badge?: string;
  tone?: "warning";
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityLabel={`${title}，${description}`}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.optionPressed]}
    >
      <View style={[styles.radio, selected && styles.radioSelected]}>{selected && <View style={styles.radioCore} />}</View>
      <View style={styles.optionCopy}>
        <View style={styles.optionTitleLine}>
          <Text style={[styles.optionTitle, tone === "warning" && styles.optionTitleWarning]}>{title}</Text>
          {badge && <Text style={styles.optionBadge}>{badge}</Text>}
        </View>
        <Text style={styles.optionDescription}>{description}</Text>
      </View>
    </Pressable>
  );
}

async function readPermissionState(): Promise<PermissionState> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return "unsupported";
  return permissionStateFromResponse(await Notifications.getPermissionsAsync());
}

function permissionStateFromResponse(
  response: Notifications.NotificationPermissionsStatus,
): PermissionState {
  if (response.granted) return "granted";
  return response.canAskAgain ? "undetermined" : "denied";
}

function permissionTitle(permission: PermissionState) {
  if (permission === "granted") return "系统通知已允许";
  if (permission === "denied") return "系统通知已关闭";
  if (permission === "unsupported") return "当前平台不支持移动 Push";
  return "尚未允许系统通知";
}

function permissionDescription(permission: PermissionState) {
  if (permission === "granted") return "等待接手和我处理中的会话可通过系统通知提醒。";
  if (permission === "denied") return "需要前往系统设置重新开启。";
  if (permission === "unsupported") return "请在 iOS 或 Android 客户端中管理此权限。";
  return "允许后设备会向 Server2 注册 Push Token。";
}

function formatConfirmedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Server2 已确认";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.canvas },
  header: { minHeight: 52, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", gap: 13 },
  back: { color: colors.navy, fontSize: 34, lineHeight: 34, fontWeight: "300" },
  headerCopy: { flex: 1 },
  title: { color: colors.ink, fontSize: 17, fontWeight: "800" },
  subtitle: { color: colors.muted, fontSize: 10, marginTop: 3 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 9 },
  loadingText: { color: colors.muted, fontSize: 11, fontWeight: "700" },
  content: { padding: 20, paddingBottom: 40 },
  privacyCard: { minHeight: 64, backgroundColor: colors.paper, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.rule, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  privacyMark: { width: 34, height: 34, borderRadius: uiTokens.radius.sm, backgroundColor: colors.greenWash, alignItems: "center", justifyContent: "center" },
  privacyMarkText: { color: colors.green, fontSize: 15 },
  privacyCopy: { flex: 1 },
  privacyTitle: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  privacyText: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  sectionLabel: { color: colors.muted, fontSize: 12, fontWeight: "600", marginTop: 24, marginBottom: 9 },
  option: { minHeight: 76, borderRadius: uiTokens.radius.md, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.rule, padding: 14, marginBottom: 8, flexDirection: "row", alignItems: "flex-start", gap: 11 },
  optionSelected: { borderColor: colors.blue, backgroundColor: colors.blueWash },
  optionPressed: { opacity: 0.72 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: colors.rule, alignItems: "center", justifyContent: "center", marginTop: 1 },
  radioSelected: { borderColor: colors.blue },
  radioCore: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.blue },
  optionCopy: { flex: 1 },
  optionTitleLine: { flexDirection: "row", alignItems: "center", gap: 7 },
  optionTitle: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  optionTitleWarning: { color: colors.orange },
  optionBadge: { color: colors.green, backgroundColor: colors.greenWash, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2, fontSize: 10, fontWeight: "800" },
  optionDescription: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 5 },
  savingLine: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 8 },
  savingText: { color: colors.blue, fontSize: 12, fontWeight: "600" },
  error: { color: colors.red, fontSize: 12, fontWeight: "600", marginTop: 8 },
  confirmedText: { color: colors.muted, fontSize: 11, marginTop: 7 },
  permissionCard: { minHeight: 76, borderRadius: uiTokens.radius.md, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.rule, padding: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  permissionCopy: { flex: 1 },
  permissionTitle: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  permissionText: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  permissionButton: { minHeight: 40, borderRadius: 12, backgroundColor: colors.primary, paddingHorizontal: 12, alignItems: "center", justifyContent: "center" },
  permissionButtonText: { color: colors.onPrimary, fontSize: 12, fontWeight: "700" },
});

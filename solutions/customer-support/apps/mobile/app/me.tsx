/**
 * 账号与设备页面
 * 展示当前用户信息、通知隐私设置、主题、缓存和版本信息。
 * 提供切换账号和退出并清除本机数据的操作。
 * 安全说明：Token 仅保存在系统安全存储，切换账号会锁定本地数据。
 */
import { router, useFocusEffect } from "expo-router";
import { ArrowLeft } from "phosphor-react-native/src/icons/ArrowLeft";
import { CaretRight } from "phosphor-react-native/src/icons/CaretRight";
import { Image } from "expo-image";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { apiBaseUrl } from "@/api/config";
import { mobileLogout } from "@/auth/api";
import { loadRecentAccounts } from "@/auth/recent-accounts";
import {
  clearSession,
  loadSession,
  saveSession,
  type MobileSession,
} from "@/auth/session";
import { leaveAccount } from "@/auth/sign-out";
import { useAvatarUpload } from "@/auth/use-avatar-upload";
import { unregisterPushDevice } from "@/notifications/register-device";
import { loadConfirmedNotificationPreference } from "@/notifications/preferences";
import { AvatarPickerSheet } from "@/ui/avatar-picker-sheet";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles, type ThemeMode } from "@/ui/theme-context";
import { uiTokens } from "@/ui/tokens";

/** 账号与设备页面组件 */
export default function MeScreen() {
  const styles = useThemedStyles(createStyles);
  const { colors, mode, setMode } = useTheme();
  const [session, setSession] = useState<MobileSession>();
  const [showPreview, setShowPreview] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [recentAccounts, setRecentAccounts] = useState<string[]>([]);
  const [switching, setSwitching] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string>();
  const [clearing, setClearing] = useState(false);
  // 头像选择器：预设 / 自定义上传 / 恢复默认（与信息名片页同一组件）。
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);

  const { uploading: avatarUploading } = useAvatarUpload(
    session,
    setSession,
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void loadSession().then(async (stored) => {
        if (!active) return;
        setSession(stored);
        if (!stored) return;
        const preference = await loadConfirmedNotificationPreference(
          stored.user.userId,
        );
        if (active) setShowPreview(preference?.showPreview ?? false);
      });
      void loadRecentAccounts().then((accounts) => {
        if (active) setRecentAccounts(accounts);
      });
      return () => {
        active = false;
      };
    }, []),
  );

  /**
   * 切换账号：走标准退出流程后跳转登录页。
   * targetUsername 非空时（最近登录列表）登录页预填该用户名。
   * 导航由 leaveAccount 的 finally 保证；这里只负责行内 loading 状态。
   */
  async function switchAccount(targetUsername?: string) {
    if (switching || switchingTo) return;
    if (targetUsername) setSwitchingTo(targetUsername);
    else setSwitching(true);
    try {
      await leaveAccount(session, {
        logout: mobileLogout,
        revokeDevice: session ? () => unregisterPushDevice(session) : undefined,
        clear: () => clearSession(),
        showSignIn: () =>
          router.replace({
            pathname: "/",
            params: targetUsername ? { username: targetUsername } : {},
          } as never),
      });
    } finally {
      setSwitching(false);
      setSwitchingTo(undefined);
    }
  }

  function confirmClearLocalData() {
    Alert.alert(
      "退出并清除本机数据？",
      "将删除当前账号的本地草稿和离线会话记录，无法恢复。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "清除并退出",
          style: "destructive",
          onPress: () => void clearAndExit(),
        },
      ],
    );
  }

  async function clearAndExit() {
    if (clearing) return;
    setClearing(true);
    try {
      if (session) {
        try {
          await mobileLogout(session.sessionToken);
        } catch {
          // Continue clearing local security data even when the server is unreachable.
        }
      }
      try {
        await clearSession({ clearLocalData: true });
      } finally {
        router.replace("/");
      }
    } finally {
      setClearing(false);
    }
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.page}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="返回"
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.headerButton}
        >
          <ArrowLeft size={23} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>账号与设备</Text>
        <View style={styles.headerButton} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.profile}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="更换头像"
            disabled={avatarUploading}
            onPress={() => setAvatarPickerOpen(true)}
            style={({ pressed }) => [
              styles.avatarButton,
              pressed && styles.avatarButtonPressed,
            ]}
          >
            {session?.user.avatarUrl ? (
              <Image
                source={{
                  uri: `${apiBaseUrl}${session.user.avatarUrl}`,
                  headers: {
                    authorization: `Bearer ${session.sessionToken}`,
                  },
                }}
                style={styles.avatar}
              />
            ) : (
              <View style={styles.avatarFallback}>
                <Text style={styles.avatarText}>
                  {(session?.user.displayName || session?.user.username || "值")
                    .trim()
                    .slice(0, 1)}
                </Text>
              </View>
            )}
            {avatarUploading ? (
              <View style={styles.avatarUploading}>
                <ActivityIndicator size="small" color={colors.onPrimary} />
              </View>
            ) : null}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="信息名片"
            onPress={() => router.push("/profile" as never)}
            style={({ pressed }) => [
              styles.profileCopy,
              pressed && styles.rowPressed,
            ]}
          >
            <Text style={styles.name}>
              {session?.user.displayName ||
                session?.user.username ||
                "值班客服"}
            </Text>
            <View style={styles.rowValueLine}>
              <Text style={styles.meta}>信息名片 · 显示名与擅长领域</Text>
              <CaretRight size={14} color={colors.blue} />
            </View>
          </Pressable>
        </View>
        {recentAccounts.length > 0 ? (
          <View style={styles.sectionBlock}>
            <Text style={styles.sectionLabel}>最近登录</Text>
            <View style={styles.rows}>
              {recentAccounts.map((account) => {
                const isCurrent = account === session?.user.username;
                return (
                  <View
                    key={account}
                    style={[styles.row, styles.recentRow]}
                  >
                    <Text style={styles.label}>{account}</Text>
                    {isCurrent ? (
                      <Text style={styles.value}>当前</Text>
                    ) : switchingTo === account ? (
                      <ActivityIndicator size="small" color={colors.blue} />
                    ) : (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`切换到 ${account}`}
                        hitSlop={10}
                        onPress={() => void switchAccount(account)}
                        style={({ pressed }) => [
                          styles.recentSwitch,
                          pressed && styles.rowPressed,
                        ]}
                      >
                        <Text style={styles.recentSwitchText}>切换</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        ) : null}
        <View style={styles.sectionBlock}>
          <Text style={styles.sectionLabel}>偏好</Text>
          <View style={styles.rows}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="通知隐私"
              onPress={() => router.push("/notification-settings" as never)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Text style={styles.label}>通知隐私</Text>
              <View style={styles.rowValueLine}>
                <Text style={styles.value}>
                  {showPreview ? "显示消息预览" : "隐藏消息正文"}
                </Text>
                <CaretRight size={17} color={colors.blue} />
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="主题"
              onPress={() => setThemeOpen(true)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Text style={styles.label}>主题</Text>
              <View style={styles.rowValueLine}>
                <Text style={styles.value}>{themeLabel(mode)}</Text>
                <CaretRight size={17} color={colors.blue} />
              </View>
            </Pressable>
          </View>
        </View>
        <View style={styles.sectionBlock}>
          <Text style={styles.sectionLabel}>数据与设备</Text>
          <View style={styles.rows}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="已隐藏会话"
              onPress={() => router.push("/hidden-conversations" as never)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Text style={styles.label}>已隐藏会话</Text>
              <CaretRight size={17} color={colors.blue} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="安全与关于"
              onPress={() => router.push("/security" as never)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Text style={styles.label}>安全与关于</Text>
              <CaretRight size={17} color={colors.blue} />
            </Pressable>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="切换账号"
          disabled={switching}
          onPress={() => void switchAccount()}
          style={styles.secondaryAction}
        >
          {switching ? (
            <ActivityIndicator size="small" color={colors.blue} />
          ) : (
            <Text style={styles.secondaryText}>切换账号</Text>
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="退出并清除本机数据"
          disabled={clearing}
          onPress={confirmClearLocalData}
          style={styles.dangerAction}
        >
          {clearing ? (
            <ActivityIndicator size="small" color={colors.red} />
          ) : (
            <Text style={styles.dangerText}>退出并清除本机数据</Text>
          )}
        </Pressable>
      </ScrollView>
      <ThemeModal
        visible={themeOpen}
        mode={mode}
        onSelect={(next) => {
          setMode(next);
          setThemeOpen(false);
        }}
        onClose={() => setThemeOpen(false)}
      />
      {session ? (
        <AvatarPickerSheet
          visible={avatarPickerOpen}
          session={session}
          onClose={() => setAvatarPickerOpen(false)}
          onSessionUpdate={(updated) => {
            setSession(updated);
            void saveSession(updated);
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

function themeLabel(mode: ThemeMode): string {
  return mode === "system" ? "跟随系统" : mode === "dark" ? "深色" : "浅色";
}

function ThemeModal({
  visible,
  mode,
  onSelect,
  onClose,
}: {
  visible: boolean;
  mode: ThemeMode;
  onSelect: (mode: ThemeMode) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const options: ThemeMode[] = ["system", "light", "dark"];
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.modalBackdrop}>
        <Pressable
          style={styles.modalDismiss}
          onPress={onClose}
          accessibilityLabel="关闭主题选择"
        />
        <View style={styles.themeSheet}>
          <Text style={styles.modalTitle}>主题</Text>
          {options.map((option) => (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ checked: mode === option }}
              onPress={() => onSelect(option)}
              style={({ pressed }) => [
                styles.themeOption,
                pressed && styles.rowPressed,
              ]}
            >
              <Text style={styles.label}>{themeLabel(option)}</Text>
              {mode === option ? (
                <Text style={[styles.value, { color: colors.primary }]}>
                  当前
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.canvas },
    header: {
      minHeight: 52,
      paddingHorizontal: 18,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    headerButton: {
      width: 38,
      height: 38,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: { color: colors.ink, fontSize: 16, fontWeight: "700" },
    content: { padding: 20, paddingBottom: 42 },
    profile: {
      marginTop: 18,
      paddingBottom: 4,
      flexDirection: "row",
      alignItems: "center",
      gap: 13,
    },
    avatarButton: { position: "relative" },
    avatarButtonPressed: { opacity: 0.8 },
    avatar: {
      height: 46,
      width: 46,
      borderRadius: uiTokens.radius.full,
      backgroundColor: colors.subtle,
    },
    avatarFallback: {
      height: 46,
      width: 46,
      borderRadius: uiTokens.radius.full,
      backgroundColor: colors.subtle,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarUploading: {
      position: "absolute",
      inset: 0,
      borderRadius: uiTokens.radius.full,
      backgroundColor: "rgba(0,0,0,0.4)",
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: { color: colors.ink, fontSize: 18, fontWeight: "600" },
    profileCopy: { flex: 1 },
    name: { color: colors.ink, fontSize: 17, fontWeight: "600" },
    meta: { color: colors.muted, fontSize: 13, marginTop: 5 },
    sectionBlock: { marginTop: 22 },
    sectionLabel: {
      color: colors.muted,
      fontSize: 12,
      fontWeight: "600",
      marginBottom: 7,
    },
    rows: {
      backgroundColor: colors.paper,
      paddingHorizontal: 14,
      borderRadius: uiTokens.radius.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.rule,
    },
    row: {
      minHeight: 56,
      paddingHorizontal: 0,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
    },
    rowPressed: { backgroundColor: colors.subtle },
    rowValueLine: { flexDirection: "row", alignItems: "center", gap: 7 },
    rowArrow: { color: colors.muted, fontSize: 20, fontWeight: "300" },
    label: { color: colors.ink, fontWeight: "700", fontSize: 14 },
    value: { color: colors.muted, fontSize: 12 },
    recentRow: { minHeight: 50 },
    recentSwitch: {
      backgroundColor: colors.subtle,
      borderRadius: uiTokens.radius.md,
      paddingHorizontal: 14,
      paddingVertical: 7,
    },
    recentSwitchText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
    secondaryAction: {
      marginTop: 28,
      backgroundColor: colors.subtle,
      borderRadius: uiTokens.radius.md,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    secondaryText: { color: colors.ink, fontWeight: "600", fontSize: 14 },
    dangerAction: { paddingVertical: 18, alignItems: "center" },
    dangerText: { color: colors.red, fontWeight: "800", fontSize: 13 },
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.32)",
      justifyContent: "flex-end",
    },
    modalDismiss: { flex: 1 },
    themeSheet: {
      backgroundColor: colors.paper,
      padding: 18,
      borderTopLeftRadius: uiTokens.radius.lg,
      borderTopRightRadius: uiTokens.radius.lg,
    },
    modalTitle: {
      color: colors.ink,
      fontSize: 17,
      fontWeight: "800",
      marginBottom: 8,
    },
    themeOption: {
      minHeight: 52,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.rule,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
  });

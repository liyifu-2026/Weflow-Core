/**
 * 修改密码页面
 * 首次登录（mustChangePassword 标记）时强制跳转到此页面；
 * 也可从「信息名片」进入自愿改密（带返回头，成功后返回上一页）。
 * 新密码要求至少 12 个字符，强制模式下修改成功后进入工作台。
 */
import { router } from "expo-router";
import { ArrowLeft } from "phosphor-react-native/src/icons/ArrowLeft";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { changePassword } from "@/auth/api";
import { authErrorCopy } from "@/auth/error-copy";
import {
  clearSession,
  loadSession,
  saveSession,
  type MobileSession,
} from "@/auth/session";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { uiTokens } from "@/ui/tokens";

/** 修改密码页面组件 */
export default function ChangePasswordScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [session, setSession] = useState<MobileSession>();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  // 强制改密：登录拦截页；自愿改密：从名片进入（mustChangePassword 已为 false）
  const forced = session?.user.mustChangePassword ?? true;

  useEffect(() => {
    void loadSession().then((stored) => {
      if (!stored) router.replace("/");
      else setSession(stored);
    });
  }, []);

  async function submit() {
    if (!session) return;
    if (newPassword.length < 12) return setError("新密码至少需要 12 个字符。");
    if (newPassword !== confirmPassword)
      return setError("两次输入的新密码不一致。");
    setSubmitting(true);
    setError(undefined);
    try {
      const user = await changePassword(session, currentPassword, newPassword);
      await saveSession({ ...session, user });
      // 强制模式进入工作台；自愿模式返回名片页
      if (forced) router.replace("/(tabs)");
      else router.back();
    } catch (reason) {
      setError(
        authErrorCopy(
          reason instanceof Error ? reason.message : "request_failed",
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function abandon() {
    await clearSession();
    router.replace("/");
  }
  if (!session)
    return (
      <SafeAreaView style={styles.loading}>
        <ActivityIndicator color={colors.blue} />
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={styles.page}>
      {!forced ? (
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="返回"
            onPress={() => router.back()}
            hitSlop={12}
            style={styles.headerButton}
          >
            <ArrowLeft size={23} color={colors.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>修改密码</Text>
          <View style={styles.headerButton} />
        </View>
      ) : null}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardArea}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <Text style={styles.kicker}>
              {forced ? "首次登录" : "账号安全"}
            </Text>
            <Text style={styles.title}>
              {forced ? "设置新密码" : "修改登录密码"}
            </Text>
            <Text style={styles.copy}>
              {forced
                ? "为了保护共享客户记录，改密前不能进入业务工作台。"
                : "新密码至少 12 个字符。改密成功后其他设备将退出登录。"}
            </Text>
          </View>
          <View style={styles.form}>
            <Text style={styles.label}>当前密码</Text>
            <TextInput
              secureTextEntry
              value={currentPassword}
              onChangeText={setCurrentPassword}
              style={styles.input}
              accessibilityLabel="当前密码"
            />
            <Text style={styles.label}>新密码</Text>
            <TextInput
              secureTextEntry
              value={newPassword}
              onChangeText={setNewPassword}
              style={styles.input}
              accessibilityLabel="新密码"
            />
            <Text style={styles.label}>确认新密码</Text>
            <TextInput
              secureTextEntry
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              style={styles.input}
              accessibilityLabel="确认新密码"
            />
            {error && (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            )}
            <TouchableOpacity
              accessibilityRole="button"
              disabled={submitting}
              onPress={() => void submit()}
              style={[styles.button, submitting && styles.disabled]}
            >
              {submitting ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.buttonText}>
                  {forced ? "更新并继续" : "更新密码"}
                </Text>
              )}
            </TouchableOpacity>
            {forced ? (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => void abandon()}
              >
                <Text style={styles.logout}>退出登录</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const createStyles = (colors: ThemeColors) => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.canvas, paddingHorizontal: 24 },
  header: {
    minHeight: 52,
    marginHorizontal: -24,
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
  keyboardArea: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: 24 },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.canvas,
  },
  hero: { flex: 1, justifyContent: "center" },
  kicker: {
    color: colors.orange,
    fontWeight: "800",
    fontSize: 11,
    letterSpacing: 1.1,
    marginBottom: 13,
  },
  title: {
    color: colors.ink,
    fontSize: 31,
    lineHeight: 39,
    fontWeight: "800",
    letterSpacing: -1,
  },
  copy: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 15,
    maxWidth: 280,
  },
  form: { gap: 8, backgroundColor: colors.paper, borderRadius: 20, padding: 18, shadowColor: colors.shadow, shadowOpacity: 0.07, shadowRadius: 18, shadowOffset: { width: 0, height: 7 }, elevation: 2 },
  label: { color: colors.muted, fontSize: 11, fontWeight: "800", marginTop: 3 },
  input: {
    height: 49,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.rule,
    borderRadius: uiTokens.radius.md,
    paddingHorizontal: 12,
    color: colors.ink,
  },
  error: { color: colors.red, fontSize: 12, fontWeight: "700", marginTop: 3 },
  button: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: uiTokens.radius.md,
    paddingVertical: 16,
    marginTop: 8,
  },
  disabled: { opacity: 0.65 },
  buttonText: { color: colors.onPrimary, fontWeight: "800", fontSize: 14 },
  logout: {
    color: colors.muted,
    textAlign: "center",
    marginTop: 10,
    fontSize: 12,
    fontWeight: "700",
  },
});

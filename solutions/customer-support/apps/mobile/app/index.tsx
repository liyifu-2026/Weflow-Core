/**
 * 登录页面（Quiet Editorial）
 *
 * 浅冷白画布 + 独立 SVG 空间大气层（左上几何、右侧干净）；表单不放入卡片，
 * 自然地存在于页面空间中——桌面右对齐非对称构图，窄屏表单为主、SVG 退背景。
 * 不展示任何品牌（无 Logo、无产品名、无欢迎语）。
 * 认证逻辑与既有错误/loading 状态不变。
 */
import { router, useLocalSearchParams } from "expo-router";
import { Eye } from "phosphor-react-native/src/icons/Eye";
import { EyeSlash } from "phosphor-react-native/src/icons/EyeSlash";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileLogin } from "@/auth/api";
import { authErrorCopy } from "@/auth/error-copy";
import { recordRecentAccount } from "@/auth/recent-accounts";
import { saveSession } from "@/auth/session";
import { LoginAtmosphere } from "@/ui/login-atmosphere";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { useReducedMotion } from "@/ui/use-reduced-motion";

/** 登录页面组件 */
export default function SignInScreen() {
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const { width: windowWidth } = useWindowDimensions();
  // 非对称构图：桌面（≥900px）表单右对齐，左侧留给空间；窄屏表单为主
  const isDesktop = windowWidth >= 900;
  const params = useLocalSearchParams<{ username?: string }>();
  const [username, setUsername] = useState(() =>
    typeof params.username === "string" ? params.username : "",
  );
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [focusedField, setFocusedField] = useState<"username" | "password" | null>(null);
  const passwordRef = useRef<TextInput>(null);
  // 页面进入：表单 180ms 微弱 fade + translate（Motion=2，仅一次）
  const [enter] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: reducedMotion ? 0 : 180,
      useNativeDriver: true,
    }).start();
  }, [enter, reducedMotion]);

  async function signIn() {
    if (submitting) return;
    if (!username.trim() || !password) {
      setError("请输入账号和密码。");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const session = await mobileLogin(username.trim(), password);
      await saveSession(session);
      await recordRecentAccount(username.trim());
      router.replace(
        session.user.mustChangePassword ? "/change-password" : "/(tabs)",
      );
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

  return (
    <View style={styles.page}>
      <LoginAtmosphere variant={isDark ? "dark" : "light"} />
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.keyboardArea}
        >
          <ScrollView
            contentContainerStyle={[
              styles.scrollContent,
              isDesktop ? styles.scrollContentDesktop : styles.scrollContentMobile,
            ]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Animated.View
              style={[
                styles.formColumn,
                {
                  opacity: enter,
                  transform: [
                    {
                      translateY: enter.interpolate({
                        inputRange: [0, 1],
                        outputRange: [6, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <Text style={styles.label}>账号</Text>
              <TextInput
                accessibilityLabel="账号"
                autoCapitalize="none"
                autoCorrect={false}
                value={username}
                onChangeText={setUsername}
                onSubmitEditing={() => passwordRef.current?.focus()}
                placeholder="输入账号"
                placeholderTextColor={colors.muted}
                returnKeyType="next"
                onFocus={() => setFocusedField("username")}
                onBlur={() => setFocusedField(null)}
                style={[
                  styles.input,
                  focusedField === "username" && styles.inputFocused,
                ]}
              />
              <Text style={styles.label}>密码</Text>
              <View style={styles.passwordField}>
                <TextInput
                  ref={passwordRef}
                  accessibilityLabel="密码"
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={!showPassword}
                  value={password}
                  onChangeText={setPassword}
                  onSubmitEditing={() => void signIn()}
                  placeholder="输入密码"
                  placeholderTextColor={colors.muted}
                  returnKeyType="done"
                  onFocus={() => setFocusedField("password")}
                  onBlur={() => setFocusedField(null)}
                  style={[
                    styles.input,
                    styles.passwordInput,
                    focusedField === "password" && styles.inputFocused,
                  ]}
                />
                <Pressable
                  accessibilityLabel={showPassword ? "隐藏密码" : "显示密码"}
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => setShowPassword((current) => !current)}
                  style={styles.passwordToggle}
                >
                  {showPassword ? (
                    <EyeSlash color={colors.muted} size={20} />
                  ) : (
                    <Eye color={colors.muted} size={20} />
                  )}
                </Pressable>
              </View>
              <Text accessibilityRole="alert" style={styles.error}>
                {error ?? " "}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={submitting}
                onPress={() => void signIn()}
                style={({ pressed }) => [
                  styles.button,
                  pressed && styles.buttonPressed,
                  submitting && styles.buttonDisabled,
                ]}
              >
                {submitting ? (
                  <View style={styles.buttonRow}>
                    <ActivityIndicator size="small" color={colors.paper} />
                    <Text style={styles.buttonText}>登录中…</Text>
                  </View>
                ) : (
                  <Text style={styles.buttonText}>登录 →</Text>
                )}
              </Pressable>
            </Animated.View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.canvas },
    safe: { flex: 1 },
    keyboardArea: { flex: 1 },
    scrollContent: { flexGrow: 1 },
    // 桌面：右侧约 38–45% 承载登录动作，左侧由留白与 SVG 构成空间
    scrollContentDesktop: {
      justifyContent: "center",
      paddingRight: "12%",
      paddingVertical: 48,
    },
    // 窄屏：表单为绝对主体，顶部留白自然呼吸
    scrollContentMobile: {
      justifyContent: "flex-start",
      paddingTop: 96,
      paddingHorizontal: 28,
      paddingBottom: 40,
    },
    formColumn: { width: "100%", maxWidth: 360 },
    label: {
      color: colors.muted,
      fontSize: 13,
      fontWeight: "600",
      marginTop: 18,
      marginBottom: 6,
    },
    input: {
      height: 48,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.rule,
      backgroundColor: "transparent",
      color: colors.ink,
      fontSize: 15,
      paddingHorizontal: 12,
    },
    inputFocused: {
      borderColor: colors.primary,
      backgroundColor: "rgba(49,91,143,0.04)",
    },
    passwordField: { position: "relative" },
    passwordInput: { paddingRight: 46 },
    passwordToggle: {
      position: "absolute",
      right: 12,
      top: 0,
      bottom: 0,
      width: 26,
      alignItems: "center",
      justifyContent: "center",
    },
    error: { color: colors.red, fontSize: 13, marginTop: 10, minHeight: 18 },
    button: {
      alignSelf: "flex-start",
      minWidth: 160,
      height: 48,
      borderRadius: 12,
      paddingHorizontal: 20,
      marginTop: 4,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.navy,
    },
    buttonRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    buttonText: { color: colors.paper, fontSize: 15, fontWeight: "700" },
    buttonPressed: { opacity: 0.85 },
    buttonDisabled: { opacity: 0.6 },
  });

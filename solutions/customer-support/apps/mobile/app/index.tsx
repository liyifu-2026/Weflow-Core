/**
 * 登录页面（Quiet Editorial × QQ 式快捷登录）
 *
 * 浅冷白画布 + SVG 大气层；表单不放入卡片。核心交互：
 * - 启动先查本地会话：有效则直接进入工作台（免登直进，消灭"关掉就要重登"）。
 * - 头像横滑条：最近登录过的账号（可记住密码），左右滑动/点选切换；
 *   划到最右的「+」进入手动输入新账号。
 * - 「下次自动登录」勾选时记住密码（SecureStore），冷启动无会话时静默自动登录。
 * 不展示任何品牌（无 Logo、无产品名、无欢迎语）。
 */
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { Check } from "phosphor-react-native/src/icons/Check";
import { Eye } from "phosphor-react-native/src/icons/Eye";
import { EyeSlash } from "phosphor-react-native/src/icons/EyeSlash";
import { Plus } from "phosphor-react-native/src/icons/Plus";
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
import { shouldAttemptAutoLogin } from "@/auth/auto-login-policy";
import { authErrorCopy } from "@/auth/error-copy";
import { recordRecentAccount, loadRecentAccounts } from "@/auth/recent-accounts";
import {
  loadSavedAccounts,
  rememberAccount,
  seedFromRecentAccounts,
  type SavedAccount,
} from "@/auth/saved-accounts";
import { loadSession, saveSession } from "@/auth/session";
import { registerPushDevice } from "@/notifications/register-device";
import { LoginAtmosphere } from "@/ui/login-atmosphere";
import { presetAvatarSource } from "@/ui/preset-avatars";
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
  const params = useLocalSearchParams<{ username?: string; manual?: string }>();
  // 启动阶段：查会话/静默自动登录期间只渲染大气层，避免表单闪现
  const [booting, setBooting] = useState(true);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberNext, setRememberNext] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [focusedField, setFocusedField] = useState<"username" | "password" | null>(null);
  const passwordRef = useRef<TextInput>(null);
  // 自动登录期间用户任何手动交互即取消（结果丢弃，不抢跳）
  const interactedRef = useRef(false);
  // 页面进入：表单 180ms 微弱 fade + translate（Motion=2，仅一次）
  const [enter] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (booting) return;
    Animated.timing(enter, {
      toValue: 1,
      duration: reducedMotion ? 0 : 180,
      useNativeDriver: true,
    }).start();
  }, [booting, enter, reducedMotion]);

  async function signIn() {
    interactedRef.current = true;
    await attemptSignIn(username, password, rememberNext);
  }

  /**
   * 执行登录：成功后保存会话、记住账号卡片（勾选时含密码）、注册推送设备并进入工作台。
   * auto = 冷启动静默登录：期间用户有交互则丢弃结果，失败静默落回表单。
   */
  async function attemptSignIn(
    name: string,
    pass: string,
    remember: boolean,
    { auto } = { auto: false },
  ): Promise<boolean> {
    if (submitting) return false;
    if (!name.trim() || !pass) {
      if (!auto) setError("请输入账号和密码。");
      return false;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const session = await mobileLogin(name.trim(), pass);
      if (auto && interactedRef.current) return false;
      await saveSession(session);
      await recordRecentAccount(name.trim());
      // mustChangePassword 的临时密码不记住，改密后重新输入
      await rememberAccount({
        username: name.trim(),
        password:
          remember && !session.user.mustChangePassword ? pass : undefined,
        avatarUrl: session.user.avatarUrl ?? null,
        avatarPreset: session.user.avatarPreset ?? null,
        displayName: session.user.displayName ?? null,
      });
      // 登录后立即注册推送设备：根布局只在冷启动时注册，
      // 不补这一步的话"登录 → 收通知"要等到下次重启 App（丢通知的隐性根因）
      void registerPushDevice(session).catch(() => undefined);
      router.replace(
        session.user.mustChangePassword ? "/change-password" : "/(tabs)",
      );
      return true;
    } catch (reason) {
      if (!auto) {
        setError(
          authErrorCopy(
            reason instanceof Error ? reason.message : "request_failed",
          ),
        );
      } else {
        setError(authErrorCopy(reason instanceof Error ? reason.message : "request_failed"));
      }
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  /** 当前输入框用户名命中的已存账号（头像条选中态） */
  const selectedAccount = accounts.find(
    (account) => account.username === username.trim(),
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 1) 会话有效：免登直进（30 天长时效 + 服务端滑动续期，绝大多数冷启动走这里）
      const stored = await loadSession().catch(() => undefined);
      if (cancelled) return;
      if (stored) {
        router.replace(
          stored.user.mustChangePassword ? "/change-password" : "/(tabs)",
        );
        return;
      }
      // 2) 无会话：载入已存账号（老用户首次进入时从旧版最近登录列表迁移）
      await seedFromRecentAccounts(loadRecentAccounts);
      const list = await loadSavedAccounts();
      if (cancelled) return;
      setAccounts(list);
      const param =
        typeof params.username === "string" ? params.username.trim() : "";
      if (param) {
        const picked = list.find((account) => account.username === param);
        setUsername(picked?.username ?? param);
        setPassword(picked?.password ?? "");
        setRememberNext(picked?.password != null);
        setBooting(false);
        return;
      }
      // 3) 静默自动登录：最近一个记住密码的账号；
      //    「切换账号 / 退出」等主动跳转（manual）不得自动登录——刚退出的账号
      //    往往仍记着密码，放行会把用户直接顶回工作台，表现为进不了登录页。
      const auto = shouldAttemptAutoLogin(params)
        ? list.find((account) => account.password)
        : undefined;
      if (auto && !interactedRef.current) {
        setUsername(auto.username);
        setPassword(auto.password ?? "");
        const ok = await attemptSignIn(auto.username, auto.password ?? "", true, {
          auto: true,
        });
        if (!ok && !cancelled) setBooting(false);
        return;
      }
      setBooting(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 选中已存账号：预填账号与记住的密码 */
  function pickAccount(account: SavedAccount) {
    interactedRef.current = true;
    setUsername(account.username);
    setPassword(account.password ?? "");
    setRememberNext(account.password != null);
    setError(undefined);
  }

  /** 「+」进入手动输入新账号 */
  function pickNewAccount() {
    interactedRef.current = true;
    setUsername("");
    setPassword("");
    setError(undefined);
  }


  if (booting) {
    return (
      <View style={styles.page}>
        <LoginAtmosphere variant={isDark ? "dark" : "light"} />
      </View>
    );
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
              {accounts.length > 0 && (
                <View style={styles.avatarStrip}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={styles.avatarRow}
                  >
                    {accounts.map((account) => {
                      const selected = selectedAccount?.username === account.username;
                      return (
                        <Pressable
                          key={account.username}
                          accessibilityRole="button"
                          accessibilityLabel={`切换到账号 ${account.displayName || account.username}`}
                          accessibilityState={{ selected }}
                          onPress={() => pickAccount(account)}
                          style={styles.avatarItem}
                        >
                          <View
                            style={[
                              styles.avatarRing,
                              selected && styles.avatarRingSelected,
                            ]}
                          >
                            {account.avatarPreset && presetAvatarSource(account.avatarPreset) ? (
                              // 预设头像：本地打包的 SVG 直渲染。登录页无可用 token，
                              // Core 头像端点要求认证，网络取图必然 401，故不走 avatarUrl。
                              <Image
                                cachePolicy="memory"
                                source={presetAvatarSource(account.avatarPreset)}
                                style={styles.avatarImage}
                                contentFit="cover"
                              />
                            ) : (
                              <View style={styles.avatarFallback}>
                                <Text style={styles.avatarInitial}>
                                  {initialOf(account)}
                                </Text>
                              </View>
                            )}
                            {account.password != null && (
                              <View style={styles.passwordDot} />
                            )}
                          </View>
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.avatarName,
                              selected && styles.avatarNameSelected,
                            ]}
                          >
                            {account.displayName || account.username}
                          </Text>
                        </Pressable>
                      );
                    })}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="添加账号"
                      onPress={pickNewAccount}
                      style={styles.avatarItem}
                    >
                      <View
                        style={[
                          styles.avatarRing,
                          styles.addRing,
                          !selectedAccount && styles.avatarRingSelected,
                        ]}
                      >
                        <Plus size={22} color={colors.muted} />
                      </View>
                      <Text style={styles.avatarName}>添加</Text>
                    </Pressable>
                  </ScrollView>
                </View>
              )}
              <Text style={styles.label}>账号</Text>
              <TextInput
                accessibilityLabel="账号"
                autoCapitalize="none"
                autoCorrect={false}
                value={username}
                onChangeText={(value) => {
                  interactedRef.current = true;
                  setUsername(value);
                }}
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
                  onChangeText={(value) => {
                    interactedRef.current = true;
                    setPassword(value);
                  }}
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
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: rememberNext }}
                accessibilityLabel="下次自动登录"
                hitSlop={8}
                onPress={() => {
                  interactedRef.current = true;
                  setRememberNext((current) => !current);
                }}
                style={styles.rememberRow}
              >
                <View
                  style={[
                    styles.checkbox,
                    rememberNext && styles.checkboxChecked,
                  ]}
                >
                  {rememberNext && <Check size={13} color={colors.paper} weight="bold" />}
                </View>
                <Text style={styles.rememberText}>下次自动登录</Text>
              </Pressable>
            </Animated.View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

/** 头像 fallback 字：优先名片名，其次用户名首字 */
function initialOf(account: SavedAccount): string {
  const source = account.displayName || account.username;
  return source.slice(0, 1).toUpperCase();
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
      paddingTop: 72,
      paddingHorizontal: 28,
      paddingBottom: 40,
    },
    formColumn: { width: "100%", maxWidth: 360 },
    avatarStrip: { marginBottom: 26 },
    avatarRow: { alignItems: "center", gap: 16, paddingVertical: 4 },
    avatarItem: { alignItems: "center", width: 64 },
    avatarRing: {
      width: 56,
      height: 56,
      borderRadius: 28,
      borderWidth: 2,
      borderColor: "transparent",
      overflow: "hidden",
    },
    avatarRingSelected: { borderColor: colors.navy },
    addRing: {
      borderStyle: "dashed",
      borderWidth: 1.5,
      borderColor: colors.rule,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "transparent",
    },
    avatarImage: { width: 52, height: 52, borderRadius: 26 },
    avatarFallback: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: colors.blueWash,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarInitial: { color: colors.navy, fontSize: 20, fontWeight: "700" },
    passwordDot: {
      position: "absolute",
      right: 2,
      bottom: 2,
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: colors.green,
      borderWidth: 1.5,
      borderColor: colors.canvas,
    },
    avatarName: {
      color: colors.muted,
      fontSize: 11,
      marginTop: 5,
      maxWidth: 64,
    },
    avatarNameSelected: { color: colors.ink, fontWeight: "700" },
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
    rememberRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 16,
      alignSelf: "flex-start",
    },
    checkbox: {
      width: 18,
      height: 18,
      borderRadius: 5,
      borderWidth: 1.5,
      borderColor: colors.rule,
      alignItems: "center",
      justifyContent: "center",
    },
    checkboxChecked: { borderColor: colors.navy, backgroundColor: colors.navy },
    rememberText: { color: colors.muted, fontSize: 13 },
  });

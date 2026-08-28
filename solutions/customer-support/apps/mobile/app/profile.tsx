/**
 * 信息名片页面
 * 客服编辑自己的对外形象：头像、显示名、专家标签，并提供修改密码入口。
 * 标签与专家队列同源——转人工时系统按标签把相关任务定向推送给你。
 * 安全说明：资料更新走 Server2 契约；旧 Server2 无 agentProfile 能力时隐藏编辑区。
 */
import { router, useFocusEffect } from "expo-router";
import { ArrowLeft } from "phosphor-react-native/src/icons/ArrowLeft";
import { CaretRight } from "phosphor-react-native/src/icons/CaretRight";
import { Image } from "expo-image";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "@/api/client";
import { getMobileCapabilities } from "@/api/capabilities";
import { apiBaseUrl } from "@/api/config";
import {
  fetchTagVocabulary,
  updateProfile,
  type AgentTag,
} from "@/auth/api";
import { profileErrorCopy } from "@/auth/error-copy";
import {
  loadSession,
  saveSession,
  type MobileSession,
} from "@/auth/session";
import { AvatarPickerSheet } from "@/ui/avatar-picker-sheet";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { uiTokens } from "@/ui/tokens";

/** 标签上限（与 Server2 词表一致） */
const MAX_TAGS = 7;

/** 信息名片页面组件 */
export default function ProfileScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [session, setSession] = useState<MobileSession>();
  const [capable, setCapable] = useState(false);
  const [vocabulary, setVocabulary] = useState<AgentTag[]>();
  const [vocabularyError, setVocabularyError] = useState(false);
  const [nameDraft, setNameDraft] = useState<string>();
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [savedFeedback, setSavedFeedback] = useState<string>();
  const [savingName, setSavingName] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  // 头像选择器：预设 / 自定义上传 / 恢复默认。
  // 头像 URL 由服务端附带基于 updated_at 的版本号，变更后自动刷新。
  const [pickerOpen, setPickerOpen] = useState(false);

  function onAvatarSessionUpdate(next: MobileSession) {
    setSession(next);
  }

  /** 会话、能力与词表随页面聚焦刷新（改密/切号回来保持最新） */
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void loadSession().then(async (stored) => {
        if (!active) return;
        setSession(stored);
        if (!stored) return;
        setNameDraft(stored.user.displayName ?? "");
        setSelectedTags(stored.user.tags ?? []);
        void getMobileCapabilities(stored)
          .then((capabilities) => {
            if (active) setCapable(capabilities.agentProfile);
          })
          .catch(() => undefined);
        void fetchTagVocabulary(stored)
          .then((tags) => {
            if (active) {
              setVocabulary(tags);
              setVocabularyError(false);
            }
          })
          .catch(() => {
            if (active) setVocabularyError(true);
          });
      });
      return () => {
        active = false;
      };
    }, []),
  );

  /** 合并服务端返回的用户信息到本地会话 */
  async function applyUserUpdate(user: MobileSession["user"]) {
    if (!session) return;
    const updated: MobileSession = { ...session, user };
    await saveSession(updated);
    setSession(updated);
  }

  function showSaved(feedback: string) {
    setSavedFeedback(feedback);
    setTimeout(() => setSavedFeedback(undefined), 1800);
  }

  async function saveDisplayName() {
    if (!session || savingName || nameDraft === undefined) return;
    const trimmed = nameDraft.trim();
    if (trimmed === (session.user.displayName ?? "")) return;
    setSavingName(true);
    try {
      // 清空输入 = 清除显示名（回落为登录账号）
      const user = await updateProfile(session, {
        displayName: trimmed.length > 0 ? trimmed : null,
      });
      await applyUserUpdate(user);
      setNameDraft(user.displayName ?? "");
      showSaved("资料已保存");
    } catch (reason) {
      Alert.alert(
        "保存失败",
        profileErrorCopy(
          reason instanceof ApiError ? reason.code : "request_failed",
        ),
      );
    } finally {
      setSavingName(false);
    }
  }

  async function saveTags() {
    if (!session || savingTags) return;
    setSavingTags(true);
    try {
      const user = await updateProfile(session, { tags: selectedTags });
      await applyUserUpdate(user);
      setSelectedTags(user.tags ?? []);
      showSaved("标签已保存");
    } catch (reason) {
      Alert.alert(
        "保存失败",
        profileErrorCopy(
          reason instanceof ApiError ? reason.code : "request_failed",
        ),
      );
    } finally {
      setSavingTags(false);
    }
  }

  function toggleTag(key: string) {
    setSelectedTags((current) => {
      if (current.includes(key)) return current.filter((tag) => tag !== key);
      if (current.length >= MAX_TAGS) {
        Alert.alert("最多选择 7 个标签", "请先取消一个已选标签。");
        return current;
      }
      return [...current, key];
    });
  }

  const nameDirty =
    nameDraft !== undefined &&
    nameDraft.trim() !== (session?.user.displayName ?? "");
  const tagsDirty =
    JSON.stringify(selectedTags) !== JSON.stringify(session?.user.tags ?? []);

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
        <Text style={styles.headerTitle}>信息名片</Text>
        <View style={styles.headerButton} />
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.profile}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="上传头像（预设 / 自定义）"
            onPress={() => setPickerOpen(true)}
            style={({ pressed }) => [
              styles.avatarButton,
              pressed && styles.avatarButtonPressed,
            ]}
          >
            {session?.user.avatarUrl ? (
              <Image
                source={{
                  uri: `${apiBaseUrl}${session.user.avatarUrl}`,
                  headers: { authorization: `Bearer ${session.sessionToken}` },
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
          </Pressable>
          <View style={styles.profileCopy}>
            <Text style={styles.name}>
              {session?.user.displayName ||
                session?.user.username ||
                "值班客服"}
            </Text>
          </View>
        </View>

        {capable ? (
          <>
            <View style={styles.sectionBlock}>
              <Text style={styles.sectionLabel}>显示名</Text>
              <View style={styles.rows}>
                <TextInput
                  value={nameDraft ?? ""}
                  onChangeText={setNameDraft}
                  placeholder={session?.user.username ?? "填写显示名"}
                  placeholderTextColor={colors.muted}
                  maxLength={24}
                  style={styles.input}
                  accessibilityLabel="显示名"
                />
                <View style={styles.rowFooter}>
                  <Text style={styles.hint}>
                    登录账号 {session?.user.username ?? ""} 不可修改
                    {savedFeedback ? (
                      <Text style={styles.saved}>　{savedFeedback}</Text>
                    ) : null}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="保存显示名"
                    disabled={!nameDirty || savingName}
                    onPress={() => void saveDisplayName()}
                    style={({ pressed }) => [
                      styles.saveButton,
                      (!nameDirty || savingName) && styles.saveDisabled,
                      pressed && nameDirty && styles.rowPressed,
                    ]}
                  >
                    {savingName ? (
                      <ActivityIndicator size="small" color={colors.onPrimary} />
                    ) : (
                      <Text style={styles.saveText}>保存</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            </View>

            <View style={styles.sectionBlock}>
              <Text style={styles.sectionLabel}>擅长领域</Text>
              <View style={styles.rows}>
                {vocabularyError ? (
                  <Text style={styles.tagError}>
                    标签加载失败，请下拉重试或稍后再试。
                  </Text>
                ) : !vocabulary ? (
                  <ActivityIndicator
                    color={colors.blue}
                    style={styles.tagLoading}
                  />
                ) : (
                  <View style={styles.chips}>
                    {vocabulary.map((tag) => {
                      const selected = selectedTags.includes(tag.key);
                      return (
                        <Pressable
                          key={tag.key}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: selected }}
                          accessibilityLabel={`标签 ${tag.displayName}`}
                          onPress={() => toggleTag(tag.key)}
                          style={({ pressed }) => [
                            styles.chip,
                            selected && styles.chipSelected,
                            pressed && styles.rowPressed,
                          ]}
                        >
                          <Text
                            style={[
                              styles.chipText,
                              selected && styles.chipTextSelected,
                            ]}
                          >
                            {tag.displayName}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
                <View style={styles.rowFooter}>
                  <Text style={styles.hint}>
                    转人工时，系统会按标签把相关任务定向推送给你
                    {savedFeedback ? (
                      <Text style={styles.saved}>　{savedFeedback}</Text>
                    ) : null}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="保存标签"
                    disabled={!tagsDirty || savingTags}
                    onPress={() => void saveTags()}
                    style={({ pressed }) => [
                      styles.saveButton,
                      (!tagsDirty || savingTags) && styles.saveDisabled,
                      pressed && tagsDirty && styles.rowPressed,
                    ]}
                  >
                    {savingTags ? (
                      <ActivityIndicator size="small" color={colors.onPrimary} />
                    ) : (
                      <Text style={styles.saveText}>保存</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            </View>
          </>
        ) : null}

        <View style={styles.sectionBlock}>
          <Text style={styles.sectionLabel}>账号</Text>
          <View style={styles.rows}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="修改密码"
              onPress={() => router.push("/change-password" as never)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Text style={styles.label}>修改密码</Text>
              <CaretRight size={17} color={colors.blue} />
            </Pressable>
          </View>
        </View>
      </ScrollView>
      <AvatarPickerSheet
        visible={pickerOpen}
        session={session}
        onClose={() => setPickerOpen(false)}
        onSessionUpdate={onAvatarSessionUpdate}
      />
    </SafeAreaView>
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
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
    },
    rowPressed: { opacity: 0.75 },
    label: { color: colors.ink, fontWeight: "700", fontSize: 14 },
    input: {
      marginTop: 12,
      height: 44,
      borderWidth: 1,
      borderColor: colors.rule,
      borderRadius: uiTokens.radius.sm,
      paddingHorizontal: 12,
      color: colors.ink,
      fontSize: 15,
    },
    rowFooter: {
      minHeight: 52,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 10,
    },
    hint: { color: colors.muted, fontSize: 12, flexShrink: 1 },
    saved: { color: colors.green, fontWeight: "700" },
    saveButton: {
      backgroundColor: colors.primary,
      borderRadius: uiTokens.radius.sm,
      paddingHorizontal: 16,
      paddingVertical: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    saveDisabled: { opacity: 0.45 },
    saveText: { color: colors.onPrimary, fontWeight: "700", fontSize: 13 },
    chips: {
      marginTop: 14,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    chip: {
      borderRadius: uiTokens.radius.full,
      borderWidth: 1,
      borderColor: colors.rule,
      backgroundColor: colors.canvas,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    chipSelected: {
      backgroundColor: colors.blueWash,
      borderColor: colors.blue,
    },
    chipText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
    chipTextSelected: { color: colors.blue },
    tagLoading: { marginVertical: 18, alignSelf: "flex-start" },
    tagError: { color: colors.red, fontSize: 12, marginVertical: 14 },
  });

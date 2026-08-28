/**
 * 头像选择器底部弹层（上传头像）。
 *
 * 选择平台预设头像、从相册自定义上传，或恢复默认（按用户名哈希分配的预设）。
 * 预设 SVG 由 Core 预设清单提供（react-native-svg 渲染），任一操作成功后
 * 更新本地会话缓存并关闭。
 */
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { fetchAvatarPresets, selectAvatarPreset } from "@/auth/api";
import { profileErrorCopy } from "@/auth/error-copy";
import { saveSession, type MobileSession } from "@/auth/session";
import { useAvatarUpload } from "@/auth/use-avatar-upload";
import { ApiError } from "@/api/client";
import { apiBaseUrl } from "@/api/config";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { uiTokens } from "@/ui/tokens";

const PRESET_SIZE = 54;

export function AvatarPickerSheet({
  visible,
  session,
  onClose,
  onSessionUpdate,
}: {
  visible: boolean;
  session: MobileSession | undefined;
  onClose: () => void;
  onSessionUpdate: (session: MobileSession) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [presets, setPresets] = useState<
    {
      id: string;
      name: string;
      seed?: string;
      svgUrl?: string;
    }[]
  >();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyPreset, setBusyPreset] = useState<string>();

  const { uploading, pickAndUploadAvatar } = useAvatarUpload(
    session,
    onSessionUpdate,
  );

  /** 弹层打开时拉取预设清单（关闭时重置） */
  useEffect(() => {
    if (!visible || !session) return;
    setLoadFailed(false);
    fetchAvatarPresets(session)
      .then(setPresets)
      .catch(() => setLoadFailed(true));
  }, [visible, session]);

  async function applyUserUpdate(user: MobileSession["user"]) {
    if (!session) return;
    const updated: MobileSession = { ...session, user };
    await saveSession(updated);
    onSessionUpdate(updated);
  }

  async function applyPreset(presetId: string) {
    if (!session || busyPreset) return;
    setBusyPreset(presetId);
    try {
      const user = await selectAvatarPreset(session, presetId);
      await applyUserUpdate(user);
      onClose();
    } catch (reason) {
      Alert.alert(
        "保存失败",
        profileErrorCopy(
          reason instanceof ApiError ? reason.code : "request_failed",
        ),
      );
    } finally {
      setBusyPreset(undefined);
    }
  }

  async function resetDefault() {
    if (!session || busyPreset) return;
    setBusyPreset("reset");
    try {
      const user = await selectAvatarPreset(session, null);
      await applyUserUpdate(user);
      onClose();
    } catch (reason) {
      Alert.alert(
        "保存失败",
        profileErrorCopy(
          reason instanceof ApiError ? reason.code : "request_failed",
        ),
      );
    } finally {
      setBusyPreset(undefined);
    }
  }

  async function pickFromLibrary() {
    // 先收起弹层再打开系统相册，避免两层浮层叠加
    onClose();
    await pickAndUploadAvatar();
  }

  const busy = Boolean(busyPreset);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.mask} onPress={onClose}>
        <Pressable
          accessibilityRole="none"
          onPress={() => undefined}
          style={styles.sheet}
        >
          <View style={styles.handle} />
          <Text style={styles.title}>上传头像</Text>
          <Text style={styles.hint}>
            选择平台预设头像，或从相册上传自定义图片。
          </Text>
          {loadFailed ? (
            <Text style={styles.error}>预设头像加载失败，请重试。</Text>
          ) : !presets ? (
            <ActivityIndicator color={colors.blue} style={styles.loading} />
          ) : (
            <View style={styles.presetRow}>
              {presets.map((preset) => {
                const active = session?.user.avatarPreset === preset.id;
                return (
                  <Pressable
                    key={preset.id}
                    accessibilityRole="button"
                    accessibilityLabel={`预设头像 ${preset.name}`}
                    accessibilityState={{ selected: active }}
                    disabled={busy || uploading}
                    onPress={() => void applyPreset(preset.id)}
                    style={[
                      styles.presetOption,
                      active && styles.presetOptionActive,
                    ]}
                  >
                    {preset.svgUrl && session ? (
                      <Image
                        source={{
                          uri: `${apiBaseUrl}${preset.svgUrl}`,
                          headers: {
                            authorization: `Bearer ${session.sessionToken}`,
                          },
                        }}
                        style={{
                          width: PRESET_SIZE,
                          height: PRESET_SIZE,
                        }}
                        contentFit="cover"
                        accessibilityLabel={preset.name}
                      />
                    ) : (
                      <View
                        style={{
                          width: PRESET_SIZE,
                          height: PRESET_SIZE,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text style={styles.presetUnavailable}>不可用</Text>
                      </View>
                    )}
                    {busyPreset === preset.id ? (
                      <View style={styles.presetBusy}>
                        <ActivityIndicator size="small" color={colors.onPrimary} />
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          )}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="从相册上传"
              disabled={busy || uploading}
              onPress={() => void pickFromLibrary()}
              style={({ pressed }) => [
                styles.primaryButton,
                (busy || uploading) && styles.buttonDisabled,
                pressed && styles.rowPressed,
              ]}
            >
              {uploading ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={styles.primaryText}>自定义上传</Text>
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="恢复默认头像"
              disabled={busy || uploading}
              onPress={() => void resetDefault()}
              style={({ pressed }) => [
                styles.secondaryButton,
                (busy || uploading) && styles.buttonDisabled,
                pressed && styles.rowPressed,
              ]}
            >
              <Text style={styles.secondaryText}>
                {busyPreset === "reset" ? "恢复中…" : "恢复默认"}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    mask: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.42)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: colors.paper,
      borderTopLeftRadius: uiTokens.radius.lg,
      borderTopRightRadius: uiTokens.radius.lg,
      paddingHorizontal: 20,
      paddingTop: 10,
      paddingBottom: 30,
    },
    handle: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.rule,
      marginBottom: 12,
    },
    title: { color: colors.ink, fontSize: 16, fontWeight: "700" },
    hint: { color: colors.muted, fontSize: 12.5, marginTop: 6 },
    error: { color: colors.red, fontSize: 12.5, marginTop: 14 },
    loading: { marginVertical: 22, alignSelf: "flex-start" },
    presetRow: {
      marginTop: 16,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
    },
    presetOption: {
      position: "relative",
      borderRadius: uiTokens.radius.md,
      borderWidth: 2,
      borderColor: "transparent",
      overflow: "hidden",
    },
    presetOptionActive: { borderColor: colors.blue },
    presetBusy: {
      position: "absolute",
      inset: 0,
      backgroundColor: "rgba(0,0,0,0.4)",
      alignItems: "center",
      justifyContent: "center",
    },
    presetUnavailable: { color: colors.muted, fontSize: 10 },
    actions: { flexDirection: "row", gap: 10, marginTop: 20 },
    primaryButton: {
      flex: 1,
      backgroundColor: colors.primary,
      borderRadius: uiTokens.radius.sm,
      paddingVertical: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryText: { color: colors.onPrimary, fontWeight: "700", fontSize: 14 },
    secondaryButton: {
      flex: 1,
      borderRadius: uiTokens.radius.sm,
      borderWidth: 1,
      borderColor: colors.rule,
      paddingVertical: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    secondaryText: { color: colors.ink, fontWeight: "700", fontSize: 14 },
    buttonDisabled: { opacity: 0.45 },
    rowPressed: { opacity: 0.75 },
  });

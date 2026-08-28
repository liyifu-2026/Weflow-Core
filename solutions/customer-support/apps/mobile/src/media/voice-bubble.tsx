/**
 * 语音消息气泡（移动端）
 * 经 Core 媒体端点加载（Bearer 鉴权，token 只进请求头）→ expo-audio 播放。
 * 展示播放/暂停 + 时长 + 转写文字；
 * audio/silk（上游转码不可用）显示不可播占位，转写文字仍展示。
 */
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Pause } from "phosphor-react-native/src/icons/Pause";
import { Play } from "phosphor-react-native/src/icons/Play";
import type { MobileSession } from "@/auth/session";
import type { ThemeColors } from "@/ui/theme";
import { useThemedStyles } from "@/ui/theme-context";
import { getMediaContentSource, getMediaMetadata } from "./api";

export function VoiceBubble({
  session,
  mediaId,
  offline,
}: {
  session: MobileSession;
  mediaId: string;
  offline: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const [meta, setMeta] = useState<
    Awaited<ReturnType<typeof getMediaMetadata>> | undefined
  >(undefined);
  const isSilk = meta?.mimeType === "audio/silk";
  // source 可选：silk 或元数据未加载时不创建播放器（silk 不可播）
  const player = useAudioPlayer(
    isSilk ? undefined : getMediaContentSource(session, mediaId),
  );
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    if (offline) return;
    let active = true;
    void getMediaMetadata(session, mediaId)
      .then((result) => {
        if (active) setMeta(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [session, mediaId, offline]);

  if (offline) {
    return <Text style={styles.offlineText}>语音需联网查看</Text>;
  }

  const durationLabel =
    status.duration > 0
      ? `${Math.max(1, Math.round(status.duration))}″`
      : "--″";

  if (isSilk) {
    return (
      <View style={styles.box}>
        <Text style={styles.unplayable}>〔语音消息〕无法播放</Text>
        {meta?.description ? (
          <Text style={styles.transcription}>{meta.description}</Text>
        ) : null}
      </View>
    );
  }

  const togglePlay = () => {
    if (status.playing) player.pause();
    else void player.play();
  };

  return (
    <View style={styles.box}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={status.playing ? "暂停语音" : "播放语音"}
        onPress={togglePlay}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
        ]}
      >
        {status.playing ? (
          <Pause size={14} color={styles.icon.color} weight="fill" />
        ) : (
          <Play size={14} color={styles.icon.color} weight="fill" />
        )}
        <Text style={styles.duration}>{durationLabel}</Text>
      </Pressable>
      {meta?.description ? (
        <Text style={styles.transcription}>{meta.description}</Text>
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    box: { flexDirection: "column", gap: 4, maxWidth: 260 },
    button: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minWidth: 96,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 12,
      backgroundColor: colors.subtle,
    },
    buttonPressed: { opacity: 0.8 },
    icon: { color: colors.blue },
    duration: {
      color: colors.ink,
      fontSize: 12,
      fontWeight: "600",
      fontVariant: ["tabular-nums"],
    },
    transcription: { color: colors.muted, fontSize: 12, lineHeight: 16 },
    unplayable: { color: colors.muted, fontSize: 12 },
    offlineText: { color: colors.muted, fontSize: 12 },
  });
}

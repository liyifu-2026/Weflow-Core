/**
 * 语音消息气泡（移动端）—— 微信风格
 * 气泡独立于文本消息气泡渲染（不再嵌套在消息气泡内），转写文字
 * 显示在语音气泡下方的独立矩形中（参考微信语音转文字交互）。
 * 经 Core 媒体端点加载（Bearer 鉴权，token 只进请求头）→ expo-audio 播放。
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

/** 语音时长（秒）：元数据缺失时回退 0，显示 --″ */
export function VoiceBubble({
  session,
  mediaId,
  offline,
  align = "left",
}: {
  session: MobileSession;
  mediaId: string;
  offline: boolean;
  /** 气泡对齐方向：left=客户侧（白底黑字），right=客服/Agent 侧（绿底白字，微信式） */
  align?: "left" | "right";
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

  const transcription = meta?.description?.trim() ?? "";

  if (offline) {
    return (
      <View style={[styles.wrap, align === "right" ? styles.wrapRight : null]}>
        <View
          style={[styles.bubble, align === "right" ? styles.bubbleMe : null]}
        >
          <Text style={[styles.offlineText, align === "right" ? styles.meMutedText : null]}>
            语音需联网查看
          </Text>
        </View>
      </View>
    );
  }

  const durationLabel =
    status.duration > 0
      ? `${Math.max(1, Math.round(status.duration))}″`
      : "--″";

  // silk 占位也保持气泡形态，转写照常展示
  if (isSilk) {
    return (
      <View style={[styles.wrap, align === "right" ? styles.wrapRight : null]}>
        <View
          style={[styles.bubble, align === "right" ? styles.bubbleMe : null]}
        >
          <Text style={[styles.unplayable, align === "right" ? styles.meMutedText : null]}>
            〔语音消息〕无法播放
          </Text>
        </View>
        {transcription ? (
          <View style={[styles.transcriptionBox, align === "right" ? styles.transcriptionBoxMe : null]}>
            <Text style={[styles.transcriptionText, align === "right" ? styles.meMutedText : null]} numberOfLines={0}>
              {transcription}
            </Text>
          </View>
        ) : null}
      </View>
    );
  }

  const togglePlay = () => {
    if (status.playing) player.pause();
    else void player.play();
  };

  return (
    <View style={[styles.wrap, align === "right" ? styles.wrapRight : null]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={status.playing ? "暂停语音" : "播放语音"}
        onPress={togglePlay}
        style={({ pressed }) => [
          styles.bubble,
          align === "right" ? styles.bubbleMe : null,
          pressed && styles.bubblePressed,
        ]}
      >
        {status.playing ? (
          <Pause size={16} color={align === "right" ? styles.meIconColor.color : styles.icon.color} weight="fill" />
        ) : (
          <Play size={16} color={align === "right" ? styles.meIconColor.color : styles.icon.color} weight="fill" />
        )}
        <Text
          style={[
            styles.duration,
            align === "right" ? styles.durationMe : null,
          ]}
        >
          {durationLabel}
        </Text>
      </Pressable>
      {transcription ? (
        <View
          style={[
            styles.transcriptionBox,
            align === "right" ? styles.transcriptionBoxMe : null,
          ]}
        >
          <Text
            style={[
              styles.transcriptionText,
              align === "right" ? styles.meMutedText : null,
            ]}
            numberOfLines={0}
          >
            {transcription}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: {
      flexDirection: "column",
      alignItems: "flex-start",
      gap: 4,
      maxWidth: 280,
    },
    wrapRight: { alignItems: "flex-end" },
    bubble: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minWidth: 104,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 14,
      borderTopLeftRadius: 4,
      backgroundColor: colors.paper,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
    },
    bubbleMe: {
      backgroundColor: colors.primary,
      borderTopLeftRadius: 14,
      borderTopRightRadius: 4,
      borderWidth: 0,
    },
    bubblePressed: { opacity: 0.85 },
    icon: { color: colors.primary },
    meIconColor: { color: colors.onPrimary },
    duration: {
      color: colors.ink,
      fontSize: 13,
      fontWeight: "600",
      fontVariant: ["tabular-nums"],
    },
    durationMe: { color: colors.onPrimary },
    transcriptionBox: {
      backgroundColor: colors.subtle,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      maxWidth: 280,
    },
    transcriptionBoxMe: { backgroundColor: colors.subtle },
    transcriptionText: { color: colors.ink, fontSize: 13, lineHeight: 18 },
    meMutedText: { color: "rgba(255,255,255,0.92)" },
    unplayable: { color: colors.muted, fontSize: 13 },
    offlineText: { color: colors.muted, fontSize: 13 },
  });
}

/**
 * 受鉴权客户图片组件
 * 统一处理图片气泡的四种状态：
 * - loading：加载中（spinner）
 * - pending：服务端图片未就绪（queued/downloading/processing*）→「正在准备图片…」+ 指数退避自动重试
 * - failed：终态失败 →「图片暂时无法加载 / 重新加载」
 * - offline：离线不发请求 →「图片需联网查看」
 * 失败只影响本气泡，不影响 Transcript；401 由元数据请求经 request() 触发既有认证失效事件。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image, type ImageStyle } from "expo-image";
import { ArrowClockwise } from "phosphor-react-native/src/icons/ArrowClockwise";
import type { MobileSession } from "@/auth/session";
import { getMediaContentSource, getMediaMetadata } from "./api";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { uiTokens } from "@/ui/tokens";

const MAX_AUTO_RETRIES = 6;

type ImagePhase = "loading" | "pending" | "failed" | "offline";

export function MediaImage({
  session,
  mediaId,
  offline,
  onOpen,
  style,
}: {
  session: MobileSession;
  mediaId: string;
  offline: boolean;
  onOpen?: () => void;
  style?: ImageStyle;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<ImagePhase>(
    offline ? "offline" : "loading",
  );
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // 未就绪：指数退避自动重试（1s/2s/4s/8s…上限 6 次），卸载时停止。
  // 达到上限时由 effectivePhase 派生为 failed，不在 effect 内 setState。
  const effectivePhase: ImagePhase =
    phase === "pending" && attempt >= MAX_AUTO_RETRIES ? "failed" : phase;
  useEffect(() => {
    if (phase !== "pending" || attempt >= MAX_AUTO_RETRIES) return;
    const delay = Math.min(1_000 * 2 ** attempt, 8_000);
    retryTimer.current = setTimeout(() => {
      setAttempt((current) => current + 1);
      setPhase("loading");
    }, delay);
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [phase, attempt]);

  const handleError = useCallback(async () => {
    setLoading(false);
    try {
      const metadata = await getMediaMetadata(session, mediaId);
      const status = metadata.status;
      if (
        status === "queued" ||
        status === "downloading" ||
        status.startsWith("processing")
      ) {
        setPhase("pending");
      } else {
        setPhase("failed");
      }
    } catch {
      setPhase("failed");
    }
  }, [session, mediaId]);

  const retry = () => {
    setAttempt(0);
    setPhase("loading");
  };

  if (effectivePhase === "offline") {
    return (
      <View style={styles.offlineBox}>
        <Text style={styles.offlineText}>图片需联网查看</Text>
      </View>
    );
  }

  if (effectivePhase === "failed") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="重新加载图片"
        onPress={retry}
        style={styles.failureBox}
      >
        <ArrowClockwise size={20} color={colors.orange} />
        <Text style={styles.failureTitle}>图片暂时无法加载</Text>
        <Text style={styles.failureAction}>重新加载</Text>
      </Pressable>
    );
  }

  if (effectivePhase === "pending") {
    return (
      <View style={styles.pendingBox}>
        <ActivityIndicator size="small" color={colors.muted} />
        <Text style={styles.pendingText}>正在准备图片…</Text>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel="查看客户图片"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.frame,
        pressed && styles.framePressed,
      ]}
    >
      <Image
        source={getMediaContentSource(session, mediaId)}
        style={[styles.image, style]}
        contentFit="contain"
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onError={() => void handleError()}
      />
      {loading ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color={colors.blue} />
        </View>
      ) : null}
      <View style={styles.hint}>
        <Text style={styles.hintText}>轻触查看</Text>
      </View>
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    frame: { position: "relative", overflow: "hidden" },
    framePressed: { opacity: 0.8 },
    image: { width: 220, height: 220 },
    loadingOverlay: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.subtle,
    },
    hint: {
      position: "absolute",
      right: 8,
      bottom: 8,
      backgroundColor: "rgba(0,0,0,0.45)",
      borderRadius: uiTokens.radius.sm,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    hintText: { color: "#FFFFFF", fontSize: 10, fontWeight: "600" },
    pendingBox: {
      width: 220,
      height: 220,
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: colors.subtle,
      borderRadius: uiTokens.radius.md,
    },
    pendingText: { color: colors.muted, fontSize: 12 },
    failureBox: {
      width: 220,
      minHeight: 110,
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      backgroundColor: colors.subtle,
      borderRadius: uiTokens.radius.md,
      padding: 12,
    },
    failureTitle: { color: colors.ink, fontSize: 13, fontWeight: "600" },
    failureAction: { color: colors.orange, fontSize: 12, fontWeight: "700" },
    offlineBox: {
      backgroundColor: colors.subtle,
      borderRadius: uiTokens.radius.md,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    offlineText: { color: colors.muted, fontSize: 12 },
  });

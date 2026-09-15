/**
 * 受鉴权文件消息卡片（微信式：圆形下载进度 + 应用内预览）
 * 展示：类型角标 + 文件名 + 大小行；点击下载（进度按字节推进）。
 * 完成后：
 *  - 图片/视频：应用内模态预览（expo-image / expo-video）
 *  - 其他文档（PDF/Office…）：经系统分享面板打开
 *    （iOS QuickLook / Android 文件 App 均可渲染 PDF 等常见格式）。
 * 下载经 expo-file-system 带认证头（token 不进 URL）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Image } from "expo-image";
import { VideoView, useVideoPlayer } from "expo-video";
import { X } from "phosphor-react-native/src/icons/X";
import type { MobileSession } from "@/auth/session";
import { apiBaseUrl } from "@/api/config";
import { getMediaMetadata } from "./api";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { uiTokens } from "@/ui/tokens";

type FilePhase = "idle" | "downloading" | "ready" | "failed";

function extensionOf(fileName: string | null | undefined): string {
  const name = fileName ?? "";
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
}

function badgeLabel(fileName: string | null | undefined): string {
  const ext = extensionOf(fileName);
  if (!ext) return "文件";
  switch (ext) {
    case "pdf":
      return "PDF";
    case "doc":
    case "docx":
      return "DOC";
    case "xls":
    case "xlsx":
      return "XLS";
    case "ppt":
    case "pptx":
      return "PPT";
    case "zip":
    case "rar":
    case "7z":
      return "ZIP";
    case "txt":
      return "TXT";
    case "mp4":
    case "mov":
      return "视频";
    default:
      return ext.slice(0, 4).toUpperCase();
  }
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const VIDEO_EXTS = new Set(["mp4", "mov"]);

function mimeOf(fileName: string | null | undefined): string {
  const ext = extensionOf(fileName);
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "txt":
      return "text/plain";
    case "csv":
      return "text/csv";
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
      return "application/json";
    case "xml":
      return "application/xml";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    // Office / 压缩包：系统分享面板按 MIME 选择打开方式，
    // 缺失映射会退化成 octet-stream（系统认不出该用什么打开）
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "zip":
      return "application/zip";
    case "rar":
      return "application/vnd.rar";
    case "7z":
      return "application/x-7z-compressed";
    case "gz":
      return "application/gzip";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    default:
      return "application/octet-stream";
  }
}

export function MediaFileBubble({
  session,
  mediaId,
  fileName,
  align = "left",
}: {
  session: MobileSession;
  mediaId: string;
  /** 转录消息携带的原始文件名（mediaFileName）；缺失时回退 */
  fileName?: string | null;
  align?: "left" | "right";
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [resolvedName] = useState<string | null>(
    fileName ?? null,
  );
  const [sizeLabel, setSizeLabel] = useState("");
  const [phase, setPhase] = useState<FilePhase>("idle");
  /** 0-1；null = 不定进度（服务端未返回长度） */
  const [progress, setProgress] = useState<number | null>(null);
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // 视频预览播放器（expo-video 3.x：useVideoPlayer + VideoView）；
  // localUri 就绪后 replace 加载源
  const player = useVideoPlayer(null, () => undefined);
  useEffect(() => {
    if (localUri) player.replace(localUri);
  }, [localUri, player]);

  useEffect(() => {
    let active = true;
    void getMediaMetadata(session, mediaId)
      .then((meta) => {
        if (!active) return;
        const size = meta.size;
        if (typeof size === "number" && size > 0) {
          setSizeLabel(
            size >= 1024 * 1024
              ? `${(size / 1024 / 1024).toFixed(1)}MB`
              : `${Math.max(1, Math.round(size / 1024))}KB`,
          );
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [session, mediaId]);

  const open = useCallback(async () => {
    if (phase === "downloading") return;
    // 已下载过：直接预览（不重复下载）
    if (localUri) {
      setPreviewOpen(true);
      return;
    }
    setPhase("downloading");
    setProgress(null);
    const name = resolvedName ?? mediaId;
    const target = `${FileSystem.cacheDirectory}${encodeURIComponent(name)}`;
    try {
      const resumable = FileSystem.createDownloadResumable(
        `${apiBaseUrl}/api/v1/media/${encodeURIComponent(mediaId)}/content`,
        target,
        { headers: { authorization: `Bearer ${session.sessionToken}` } },
        (writeProgress) => {
          const total = writeProgress.totalBytesExpectedToWrite;
          if (total > 0) {
            setProgress(
              Math.min(0.99, writeProgress.totalBytesWritten / total),
            );
          } else {
            setProgress(null);
          }
        },
      );
      const result = await resumable.downloadAsync();
      if (!result?.uri) throw new Error("download failed");
      setLocalUri(result.uri);
      setProgress(1);
      setPhase("ready");
      // 文档类直接走系统面板；图片/视频走下方应用内模态
      if (!IMAGE_EXTS.has(extensionOf(name)) && !VIDEO_EXTS.has(extensionOf(name))) {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(result.uri, {
            mimeType: mimeOf(name),
            dialogTitle: name,
          });
        }
      } else {
        setPreviewOpen(true);
      }
    } catch {
      setPhase("failed");
    }
  }, [phase, session, mediaId, resolvedName, localUri]);

  const name = resolvedName ?? "附件";
  const me = align === "right";
  const ext = extensionOf(name);
  const isImage = IMAGE_EXTS.has(ext);
  const isVideo = VIDEO_EXTS.has(ext);
  const percent =
    progress === null ? null : Math.round(Math.min(1, progress) * 100);

  const RING = 44;
  const ringRotation =
    progress === null ? "45deg" : `${Math.min(1, progress) * 360 - 90}deg`;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`下载文件 ${name}`}
        onPress={() => void open()}
        style={({ pressed }) => [
          styles.card,
          me ? styles.cardMe : null,
          pressed && styles.pressed,
        ]}
      >
        <View style={styles.badgeWrap}>
          <View style={[styles.badge, me ? styles.badgeMe : null]}>
            <Text style={[styles.badgeText, me ? styles.badgeTextMe : null]}>
              {badgeLabel(name)}
            </Text>
          </View>
          {phase === "downloading" ? (
            percent === null ? (
              <ActivityIndicator
                size="small"
                color={me ? "#fff" : colors.blue}
                style={styles.progressOverlay}
              />
            ) : (
              <View style={styles.progressOverlay} pointerEvents="none">
                <View
                  style={[
                    styles.ringTrack,
                    { width: RING, height: RING, borderRadius: RING / 2 },
                  ]}
                />
                <View
                  style={[
                    styles.ringBarWrap,
                    { width: RING, height: RING, transform: [{ rotate: ringRotation }] },
                  ]}
                >
                  <View
                    style={[
                      styles.ringBar,
                      {
                        width: RING,
                        height: RING,
                        borderRadius: RING / 2,
                        borderColor: me ? "rgba(255,255,255,0.9)" : colors.blue,
                      },
                    ]}
                  />
                </View>
                <Text style={[styles.ringText, me ? styles.ringTextMe : null]}>
                  {percent}
                </Text>
              </View>
            )
          ) : null}
        </View>
        <View style={styles.body}>
          <Text numberOfLines={2} style={[styles.name, me ? styles.textMe : null]}>
            {name}
          </Text>
          <Text style={[styles.meta, me ? styles.textMeMuted : null]}>
            {phase === "downloading"
              ? percent === null
                ? "下载中…"
                : `下载中 ${percent}%`
              : phase === "failed"
                ? "下载失败，点击重试"
                : localUri
                  ? "轻触查看"
                  : sizeLabel || "点击下载"}
          </Text>
        </View>
      </Pressable>

      {/* 应用内预览：图片/视频模态（文档类在 open() 内走系统面板） */}
      <Modal
        visible={previewOpen && (isImage || isVideo)}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewOpen(false)}
      >
        <View style={styles.previewBackdrop}>
          <Pressable
            style={styles.previewClose}
            onPress={() => setPreviewOpen(false)}
            accessibilityLabel="关闭预览"
          >
            <X size={22} color="#fff" />
          </Pressable>
          {localUri && isImage ? (
            <Image
              source={{ uri: localUri }}
              style={styles.previewImage}
              contentFit="contain"
            />
          ) : null}
          {localUri && isVideo ? (
            <VideoView
              player={player}
              style={styles.previewVideo}
              contentFit="contain"
            />
          ) : null}
        </View>
      </Modal>
    </>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: uiTokens.spacing.sm,
      width: 236,
      maxWidth: "100%",
      padding: uiTokens.spacing.sm,
      borderRadius: uiTokens.radius.md,
      backgroundColor: colors.paper,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
    },
    cardMe: {
      backgroundColor: colors.blue,
      borderColor: "transparent",
    },
    pressed: { opacity: 0.85 },
    badgeWrap: {
      position: "relative",
      alignItems: "center",
      justifyContent: "center",
      width: 38,
      height: 38,
    },
    badge: {
      alignItems: "center",
      justifyContent: "center",
      width: 38,
      height: 38,
      borderRadius: uiTokens.radius.sm,
      backgroundColor: colors.blue,
    },
    badgeMe: { backgroundColor: "rgba(255,255,255,0.25)" },
    badgeText: {
      color: "#fff",
      fontSize: 11,
      fontWeight: "600",
    },
    badgeTextMe: { color: "#fff" },
    progressOverlay: {
      position: "absolute",
      top: -3,
      left: -3,
      right: -3,
      bottom: -3,
      alignItems: "center",
      justifyContent: "center",
    },
    ringTrack: {
      position: "absolute",
      borderWidth: 2.5,
      borderColor: "rgba(79,124,255,0.25)",
    },
    ringBarWrap: {
      position: "absolute",
      alignItems: "center",
      justifyContent: "center",
    },
    ringBar: {
      position: "absolute",
      borderWidth: 2.5,
      borderTopColor: "transparent",
      borderRightColor: "transparent",
      borderBottomColor: "transparent",
    },
    ringText: {
      position: "absolute",
      color: colors.blue,
      fontSize: 10,
      fontWeight: "700",
      backgroundColor: colors.paper,
      paddingHorizontal: 3,
      borderRadius: 6,
      overflow: "hidden",
    },
    ringTextMe: { color: colors.blue },
    body: { flex: 1, minWidth: 0, gap: 2 },
    name: {
      color: colors.ink,
      fontSize: 13,
      lineHeight: 18,
    },
    meta: {
      color: colors.muted,
      fontSize: 11,
    },
    textMe: { color: "#fff" },
    textMeMuted: { color: "rgba(255,255,255,0.75)" },
    previewBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.92)",
      alignItems: "center",
      justifyContent: "center",
    },
    previewClose: {
      position: "absolute",
      top: 48,
      right: 20,
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: "rgba(255,255,255,0.15)",
      alignItems: "center",
      justifyContent: "center",
    },
    previewImage: { width: "100%", height: "80%" },
    previewVideo: { width: "100%", height: "60%" },
  });

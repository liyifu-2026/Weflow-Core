/**
 * 客户图片全屏查看器
 * 打开时优先加载原图（高清）；原图缺失/失败自动降级为缩略图；
 * 缩略图也失败时显示失败态并支持重试（重试会重新尝试原图）。
 * 仅在线查看，不保存到本机。
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { X } from "phosphor-react-native/src/icons/X";
import type { MobileSession } from "@/auth/session";
import { useReducedMotion } from "@/ui/use-reduced-motion";
import { getMediaContentSource, getMediaOriginalContentSource } from "./api";

export function MediaViewerModal({
  session,
  mediaId,
  onClose,
}: {
  session: MobileSession;
  mediaId: string;
  onClose: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [loading, setLoading] = useState(true);
  const [useThumbnail, setUseThumbnail] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <Modal
      visible
      transparent
      animationType={reducedMotion ? "none" : "fade"}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View accessibilityViewIsModal style={styles.mediaViewer}>
        <View style={styles.mediaViewerTopline}>
          <View>
            <Text style={styles.mediaViewerTitle}>客户图片</Text>
            <Text style={styles.mediaViewerPrivacy}>
              仅在线查看 · 不保存到本机
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭图片"
            onPress={onClose}
            style={styles.mediaViewerClose}
          >
            <X size={22} color="white" />
          </Pressable>
        </View>
        <View style={styles.mediaViewerStage}>
          {!failed ? (
            <Image
              key={`${useThumbnail ? "thumb" : "original"}-${String(attempt)}`}
              source={
                useThumbnail
                  ? getMediaContentSource(session, mediaId)
                  : getMediaOriginalContentSource(session, mediaId)
              }
              style={styles.mediaViewerImage}
              contentFit="contain"
              onLoadStart={() => setLoading(true)}
              onLoadEnd={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                // 原图失败 → 降级缩略图；缩略图也失败 → 终态失败
                if (!useThumbnail) {
                  setUseThumbnail(true);
                } else {
                  setFailed(true);
                }
              }}
            />
          ) : (
            <View style={styles.mediaViewerFailure}>
              <Text style={styles.mediaViewerFailureTitle}>
                图片暂时无法查看
              </Text>
              <Text style={styles.mediaViewerFailureText}>
                请检查网络连接后重试。
              </Text>
              <Pressable
                onPress={() => {
                  setFailed(false);
                  setUseThumbnail(false);
                  setAttempt((value) => value + 1);
                }}
                style={styles.mediaViewerRetry}
              >
                <Text style={styles.mediaViewerRetryText}>重新加载</Text>
              </Pressable>
            </View>
          )}
          {loading && !failed && (
            <ActivityIndicator
              size="large"
              color="white"
              style={styles.mediaViewerSpinner}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mediaViewer: {
    flex: 1,
    backgroundColor: "#0B1519",
    paddingTop: Platform.OS === "android" ? 38 : 12,
  },
  mediaViewerTopline: {
    minHeight: 68,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  mediaViewerTitle: { color: "white", fontSize: 15, fontWeight: "800" },
  mediaViewerPrivacy: { color: "#91A3A8", fontSize: 9, marginTop: 4 },
  mediaViewerClose: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  mediaViewerStage: {
    flex: 1,
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  mediaViewerImage: { width: "100%", height: "100%" },
  mediaViewerSpinner: { position: "absolute" },
  mediaViewerFailure: { alignItems: "center", padding: 24 },
  mediaViewerFailureTitle: {
    color: "white",
    fontSize: 15,
    fontWeight: "800",
  },
  mediaViewerFailureText: { color: "#91A3A8", fontSize: 11, marginTop: 6 },
  mediaViewerRetry: {
    minHeight: 42,
    borderRadius: 13,
    backgroundColor: "white",
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 18,
  },
  mediaViewerRetryText: {
    color: "#18181B",
    fontSize: 11,
    fontWeight: "800",
  },
});

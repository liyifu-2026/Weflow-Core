/**
 * 客户头像组件。
 *
 * 经 Core 头像代理端点加载（Bearer 鉴权，token 只进请求头不进 URL），
 * 无 contactId 或加载失败时降级为首字母圆块，与原有占位视觉一致。
 */
import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiBaseUrl } from "@/api/config";
import type { ThemeColors } from "@/ui/theme";
import { useThemedStyles } from "@/ui/theme-context";

export function UserAvatar({
  contactId,
  fallbackName,
  sessionToken,
  size = 52,
}: {
  contactId?: string | null;
  fallbackName: string;
  sessionToken: string;
  size?: number;
}) {
  const styles = useThemedStyles(createStyles);
  const [failed, setFailed] = useState(false);
  const letter = (fallbackName || "?").trim().slice(0, 1).toUpperCase();

  if (!contactId || failed) {
    return (
      <View
        style={[
          styles.avatar,
          { width: size, height: size, borderRadius: size / 2 },
        ]}
      >
        <Text style={[styles.avatarText, { fontSize: size * 0.38 }]}>
          {letter}
        </Text>
      </View>
    );
  }
  return (
    <Image
      source={{
        uri: `${apiBaseUrl}/api/v1/contacts/${encodeURIComponent(contactId)}/avatar`,
        headers: { authorization: `Bearer ${sessionToken}` },
      }}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: styles.avatar.backgroundColor,
      }}
      contentFit="cover"
      onError={() => setFailed(true)}
      accessibilityLabel={fallbackName}
    />
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    avatar: {
      backgroundColor: colors.subtle,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: { color: colors.ink, fontWeight: "600" },
  });
}

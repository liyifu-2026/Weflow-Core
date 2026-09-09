import { Pressable, Text, View } from "react-native";
import { useTheme, useThemedStyles } from "@/ui/theme-context";

import { createStyles } from "./styles";

/** 操作面板组件：显示状态提示和操作按钮（如"接手处理"、"只读"等） */
export function ActionPanel({
  title,
  details,
  action,
  tone,
  onPress,
  disabled,
  secondaryLabel,
  onSecondary,
}: {
  title: string;
  details?: string[];
  action?: string;
  tone: "primary" | "muted";
  onPress?: () => void;
  disabled?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>{title}</Text>
      {details?.length ? (
        <View style={styles.panelDetails}>
          {details.map((detail) => (
            <View key={detail} style={styles.panelDetailRow}>
              <View style={styles.panelDetailDot} />
              <Text numberOfLines={2} style={styles.panelDetailText}>
                {detail}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.panelActions}>
        {secondaryLabel && onSecondary ? (
          <Pressable
            accessibilityRole="button"
            onPress={onSecondary}
            style={({ pressed }) => [
              styles.panelButton,
              styles.panelButtonSecondary,
              pressed && styles.panelButtonPressed,
            ]}
          >
            <Text style={styles.panelButtonSecondaryText}>{secondaryLabel}</Text>
          </Pressable>
        ) : null}
        {action ? (
          <Pressable
            accessibilityRole="button"
            onPress={onPress}
            disabled={disabled || !onPress}
            style={({ pressed }) => [
              styles.panelButton,
              {
                backgroundColor: tone === "primary" ? colors.primary : colors.paper,
                borderWidth: tone === "primary" ? 0 : 1,
                borderColor: colors.rule,
              },
              pressed && onPress && styles.panelButtonPressed,
            ]}
          >
            <Text
              style={[
                styles.panelButtonText,
                { color: tone === "primary" ? colors.onPrimary : colors.muted },
              ]}
            >
              {action}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

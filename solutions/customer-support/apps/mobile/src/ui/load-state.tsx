import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import { useTheme } from "./theme-context";
import { uiTokens } from "./tokens";

export type LoadStateKind = "loading" | "error" | "empty";

export function LoadState({
  kind,
  title,
  description,
  actionLabel,
  onAction,
  illustration,
}: {
  kind: LoadStateKind;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  illustration?: ReactNode;
}) {
  const { colors } = useTheme();
  const loading = kind === "loading";
  return (
    <View style={styles.container}>
      {illustration ? (
        <View style={styles.illustration}>{illustration}</View>
      ) : null}
      {loading ? <ActivityIndicator color={colors.blue} /> : null}
      <Text style={[styles.title, { color: colors.ink }]}>{title}</Text>
      {description ? (
        <Text style={[styles.description, { color: colors.muted }]}>
          {description}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={[styles.actionText, { color: colors.blue }]}>
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 260,
    alignItems: "center",
    justifyContent: "center",
    gap: uiTokens.spacing.sm,
    paddingHorizontal: 24,
  },
  illustration: { height: 96, justifyContent: "center", marginBottom: 4 },
  title: { fontSize: uiTokens.type.body, fontWeight: "600", textAlign: "center" },
  description: { fontSize: uiTokens.type.auxiliary, lineHeight: 18, textAlign: "center" },
  action: {
    minHeight: uiTokens.control.minTouch,
    justifyContent: "center",
    paddingHorizontal: uiTokens.spacing.sm,
  },
  actionText: { fontSize: uiTokens.type.auxiliary, fontWeight: "600" },
  pressed: { opacity: 0.65 },
});

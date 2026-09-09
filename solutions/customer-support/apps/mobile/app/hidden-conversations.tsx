/**
 * 已隐藏会话
 * 列表页左滑「隐藏」的会话在此恢复显示。
 */
import { router, useFocusEffect } from "expo-router";
import { ArrowLeft } from "phosphor-react-native/src/icons/ArrowLeft";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { loadSession } from "@/auth/session";
import {
  listHiddenConversations,
  setConversationHidden,
} from "@/conversations/api";
import type { ConversationPreview } from "@/conversations/model";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";

export default function HiddenConversationsScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<ConversationPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const session = await loadSession();
      if (!session) {
        router.replace("/");
        return;
      }
      setItems((await listHiddenConversations(session)).conversations);
    } catch {
      // 静默；下拉/重进重试
    } finally {
      setLoading(false);
    }
  }

  useFocusEffect(
    useCallback(() => {
      void load();
    }, []),
  );

  async function restore(item: ConversationPreview) {
    const session = await loadSession();
    if (!session || busyId) return;
    setBusyId(item.id);
    try {
      await setConversationHidden(session, item.id, false);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch {
      // 静默；保留行
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.page}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="返回"
          hitSlop={12}
          onPress={() => router.back()}
          style={({ pressed }) => pressed && styles.backPressed}
        >
          <ArrowLeft size={23} color={colors.ink} weight="regular" />
        </Pressable>
        <Text style={styles.headerTitle}>已隐藏会话</Text>
        <View style={styles.headerButton} />
      </View>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.blue} />
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={styles.emptyText}>暂无隐藏的会话</Text>
            </View>
          )
        }
        renderItem={({ item, index }) => (
          <View
            style={[
              styles.row,
              index !== items.length - 1 && styles.rowDivider,
            ]}
          >
            <View style={styles.rowCopy}>
              <Text numberOfLines={1} style={styles.name}>
                {item.name}
              </Text>
              <Text numberOfLines={1} style={styles.preview}>
                {item.preview || "无预览"}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`恢复显示 ${item.name}`}
              disabled={busyId === item.id}
              onPress={() => void restore(item)}
              style={({ pressed }) => [
                styles.restoreButton,
                pressed && styles.restoreButtonPressed,
              ]}
            >
              {busyId === item.id ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={styles.restoreText}>恢复显示</Text>
              )}
            </Pressable>
          </View>
        )}
        showsVerticalScrollIndicator={false}
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
      gap: 13,
    },
    headerTitle: { flex: 1, color: colors.ink, fontSize: 16, fontWeight: "700" },
    headerButton: { width: 23 },
    backPressed: { opacity: 0.8 },
    list: { paddingHorizontal: 20, paddingBottom: 36, flexGrow: 1 },
    row: {
      minHeight: 64,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 10,
    },
    rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.rule },
    rowCopy: { flex: 1, minWidth: 0 },
    name: { color: colors.ink, fontSize: 15, fontWeight: "700" },
    preview: { color: colors.muted, fontSize: 13, marginTop: 4 },
    restoreButton: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 12,
      backgroundColor: colors.blueWash,
      minWidth: 78,
      alignItems: "center",
    },
    restoreButtonPressed: { opacity: 0.8 },
    restoreText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
    center: { alignItems: "center", paddingTop: 80 },
    emptyText: { color: colors.muted, fontSize: 14 },
  });

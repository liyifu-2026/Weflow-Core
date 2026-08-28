import { router } from "expo-router";
import { ArrowLeft } from "phosphor-react-native/src/icons/ArrowLeft";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Constants from "expo-constants";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";

export default function SecurityScreen() {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const version = Constants.expoConfig?.version ?? "未知版本";
  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityLabel="返回" hitSlop={12}><ArrowLeft size={23} color={colors.ink} /></Pressable>
        <Text style={styles.title}>安全与关于</Text>
        <View style={styles.spacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>本机数据</Text>
          <Text style={styles.body}>登录凭证只保存在系统安全存储。草稿和离线文本按账号隔离，并在退出清理或安全会话失效时删除。</Text>
        </View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>隐私</Text>
          <Text style={styles.body}>应用进入后台时会隐藏客户内容。通知默认不显示消息正文，知识检索和文件预览只通过受保护的 Server2 接口进行。</Text>
        </View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>关于</Text>
          <Text style={styles.body}>Weflow · {version}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.canvas },
  header: { minHeight: 56, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  spacer: { width: 23 },
  title: { color: colors.ink, fontSize: 17, fontWeight: "800" },
  content: { paddingHorizontal: 18 },
  section: {
    paddingVertical: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.rule,
  },
  sectionTitle: { color: colors.ink, fontSize: 14, fontWeight: "800" },
  body: { color: colors.muted, fontSize: 12, lineHeight: 19, marginTop: 8 },
});

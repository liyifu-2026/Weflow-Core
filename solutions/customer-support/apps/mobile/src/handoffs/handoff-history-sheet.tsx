/**
 * Handoff 历史 Sheet（全屏只读审计）
 * 展示本会话全部 Cycle 的责任流转：状态、原因/转交说明、操作者、
 * 结果与异步 resolutionSummary、时间。低频审计信息，不污染当前操作页面。
 */
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft } from "phosphor-react-native/src/icons/ArrowLeft";
import { formatDay, formatTime } from "@/ui/format";
import type { HandoffCycle } from "./model";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";

const CYCLE_STATUS_COPY: Record<string, string> = {
  pending: "等待接手",
  transfer_pending: "等待对方接手",
  in_progress: "人工处理中",
  finished: "已结束",
  resolved: "已结束",
  cancelled: "已取消",
};

function cycleStatusCopy(status: string): string {
  return CYCLE_STATUS_COPY[status] ?? status;
}

function cycleResultCopy(result: string | null | undefined): string {
  if (!result) return "";
  const copy: Record<string, string> = {
    transferred: "转交",
    answered_question: "已解答",
    information_collected: "已收集信息",
    customer_no_response: "客户未响应",
    resolved_by_human: "人工解决",
    other: "其他",
  };
  return copy[result] ?? result;
}

export function HandoffHistorySheet({
  visible,
  cycles,
  onClose,
}: {
  visible: boolean;
  cycles: HandoffCycle[];
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.page}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="关闭 Handoff 历史"
            hitSlop={12}
            onPress={onClose}
            style={styles.headerButton}
          >
            <ArrowLeft size={23} color={colors.ink} />
          </Pressable>
          <Text style={styles.headerTitle}>Handoff 历史</Text>
          <View style={styles.headerButton} />
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          {cycles.length === 0 ? (
            <Text style={styles.empty}>当前会话尚无人工接管记录</Text>
          ) : (
            cycles.map((cycle, index) => (
              <View key={cycle.cycleId} style={styles.cycleCard}>
                <View style={styles.cycleHeader}>
                  <Text style={styles.cycleIndex}>
                    周期 {cycles.length - index}
                  </Text>
                  <View style={styles.cycleHeaderRight}>
                    {cycle.handoffRevision ? (
                      <Text style={styles.cycleRevision}>
                        rev {cycle.handoffRevision}
                      </Text>
                    ) : null}
                    <Text style={styles.cycleStatus}>
                      {cycleStatusCopy(cycle.status)}
                    </Text>
                  </View>
                </View>
                {cycle.reason ? (
                  <View style={styles.field}>
                    <Text style={styles.fieldLabel}>
                      {cycle.transferContext ? "转交说明" : "接管原因"}
                    </Text>
                    <Text style={styles.fieldText}>{cycle.reason}</Text>
                  </View>
                ) : null}
                {cycle.transferContext?.transferReason ? (
                  <View style={styles.field}>
                    <Text style={styles.fieldLabel}>转交留言</Text>
                    <Text style={styles.fieldText}>
                      {cycle.transferContext.transferReason}
                    </Text>
                  </View>
                ) : null}
                {cycle.transferContext ? (
                  <View style={styles.field}>
                    <Text style={styles.fieldLabel}>转交去向</Text>
                    <Text style={styles.fieldText}>
                      {cycle.transferContext.targetType === "queue"
                        ? "专业队列"
                        : "指定客服"}
                    </Text>
                  </View>
                ) : null}
                {cycle.result ? (
                  <View style={styles.field}>
                    <Text style={styles.fieldLabel}>结果</Text>
                    <Text style={styles.fieldText}>
                      {cycleResultCopy(cycle.result)}
                      {cycle.resolution ? ` · ${cycle.resolution}` : ""}
                    </Text>
                  </View>
                ) : null}
                {cycle.resolutionSummary?.text ? (
                  <View style={styles.field}>
                    <Text style={styles.fieldLabel}>处理总结</Text>
                    <Text style={styles.fieldText}>
                      {cycle.resolutionSummary.text}
                    </Text>
                  </View>
                ) : null}
                <View style={styles.timeline}>
                  <Text style={styles.timeText}>
                    创建 {formatDay(cycle.createdAt)} {formatTime(cycle.createdAt)}
                  </Text>
                  {cycle.acceptedAt ? (
                    <Text style={styles.timeText}>
                      接手 {formatDay(cycle.acceptedAt)} {formatTime(cycle.acceptedAt)}
                    </Text>
                  ) : null}
                  {cycle.finishedAt ? (
                    <Text style={styles.timeText}>
                      结束 {formatDay(cycle.finishedAt)} {formatTime(cycle.finishedAt)}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.canvas },
    header: {
      minHeight: 52,
      paddingHorizontal: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    headerButton: {
      minWidth: 38,
      minHeight: 38,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: { color: colors.ink, fontSize: 16, fontWeight: "700" },
    content: { padding: 20, paddingBottom: 42, gap: 14 },
    empty: { color: colors.muted, fontSize: 13, paddingVertical: 24 },
    cycleCard: {
      backgroundColor: colors.paper,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
      padding: 14,
      gap: 10,
    },
    cycleHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    cycleIndex: { color: colors.ink, fontSize: 13, fontWeight: "700" },
    cycleHeaderRight: { flexDirection: "row", alignItems: "center", gap: 8 },
    cycleRevision: { color: colors.muted, fontSize: 11 },
    cycleStatus: {
      color: colors.blue,
      fontSize: 11,
      fontWeight: "700",
      backgroundColor: colors.blueWash,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    field: { gap: 3 },
    fieldLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: "600",
    },
    fieldText: { color: colors.ink, fontSize: 12, lineHeight: 18 },
    timeline: { gap: 3, marginTop: 2 },
    timeText: { color: colors.muted, fontSize: 11 },
  });

/**
 * 交接摘要三档折叠组件（HandoffBrief）
 * collapsed（一行标题）/ compact（必要处理信息）/ expanded（完整字段，内部滚动）。
 * - 点击标题行循环切换三档（§7 tap 方案）
 * - 首次进入当前 Cycle 由父组件决定默认档位（compact），再次进入默认 collapsed
 * - compact 下用户滚动 Transcript 自动降为 collapsed；用户手动展开后本生命周期不自动折叠
 * - 键盘打开强制 collapsed
 * 文案保持减法：问题 / 已确认 / 待确认 / 已尝试 / 下一步 / 转人工 / 转交说明。
 */
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ArrowRight } from "phosphor-react-native/src/icons/ArrowRight";
import { ArrowsLeftRight } from "phosphor-react-native/src/icons/ArrowsLeftRight";
import { CaretDown } from "phosphor-react-native/src/icons/CaretDown";
import { CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { Question } from "phosphor-react-native/src/icons/Question";
import { Warning } from "phosphor-react-native/src/icons/Warning";
import { Wrench } from "phosphor-react-native/src/icons/Wrench";
import type { HandoffBriefingViewModel } from "@/conversations/handoff-briefing";
import type { ThemeColors } from "@/ui/theme";
import { useThemedStyles } from "@/ui/theme-context";
import { uiTokens } from "@/ui/tokens";

export type BriefMode = "collapsed" | "compact" | "expanded";

/** 点击标题的档位循环：collapsed → compact → expanded → collapsed */
export function nextBriefMode(mode: BriefMode): BriefMode {
  if (mode === "collapsed") return "compact";
  if (mode === "compact") return "expanded";
  return "collapsed";
}

export function HandoffBrief({
  briefing,
  staleMessageCount,
  transferNote,
  defaultMode,
  keyboardVisible,
  transcriptScrolled,
}: {
  briefing: HandoffBriefingViewModel;
  staleMessageCount: number;
  transferNote: string | null;
  defaultMode: BriefMode;
  keyboardVisible: boolean;
  transcriptScrolled: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const [mode, setMode] = useState<BriefMode>(defaultMode);
  const [manualIntent, setManualIntent] = useState(false);

  // 派生档位：键盘打开 → 强制 collapsed（最高优先级）；
  // compact 下滚动 Transcript → 自动折叠；用户手动展开（manualIntent）后不抢控制权。
  // 父组件以 cycleId 作为 key 重挂载，Cycle 变化时状态自然重置为新默认档位。
  const effectiveMode: BriefMode =
    keyboardVisible
      ? "collapsed"
      : transcriptScrolled && mode === "compact" && !manualIntent
        ? "collapsed"
        : mode;

  const advance = () => {
    setMode((current) => nextBriefMode(current));
    setManualIntent(true);
  };

  const collapsed = effectiveMode === "collapsed";
  const expanded = effectiveMode === "expanded";

  if (collapsed) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="交接摘要，已折叠，点击展开"
        onPress={advance}
        style={({ pressed }) => [
          styles.container,
          styles.containerCollapsed,
          pressed && styles.containerPressed,
        ]}
      >
        <View style={styles.collapsedRow}>
          <Text style={styles.collapsedTitle} numberOfLines={1}>
            交接 · {briefing.headline}
          </Text>
          <CaretDown size={15} color={styles.collapsedChevron.color} />
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`交接摘要，${expanded ? "已展开" : "简要"}`}
      onPress={advance}
      style={({ pressed }) => [
        styles.container,
        pressed && styles.containerPressed,
      ]}
    >
      <View style={styles.headlineRow}>
        <Text style={styles.headline} numberOfLines={expanded ? undefined : 2}>
          {briefing.headline}
        </Text>
        <CaretDown
          size={15}
          color={styles.meta.color}
          style={expanded ? styles.chevronUp : styles.chevronDown}
        />
      </View>
      {staleMessageCount > 0 ? (
        <Text style={styles.meta}>
          摘要基于 {staleMessageCount} 条消息前的上下文
        </Text>
      ) : null}
      <ScrollView
        style={expanded ? styles.expandedScroll : undefined}
        nestedScrollEnabled
        scrollEnabled={expanded}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.body}>
          {briefing.confirmedFacts.length ? (
            <BriefRow icon="confirmed">
              {briefing.confirmedFacts.slice(0, expanded ? undefined : 3).join(" · ")}
            </BriefRow>
          ) : null}
          {transferNote ? (
            <BriefRow icon="transfer">{`转交留言：${transferNote}`}</BriefRow>
          ) : null}
          {briefing.suggestedNextStep ? (
            <BriefRow icon="next">{briefing.suggestedNextStep}</BriefRow>
          ) : null}
          {briefing.handoffReason ? (
            <BriefRow icon="reason">{briefing.handoffReason}</BriefRow>
          ) : null}
          {expanded ? (
            <>
              {briefing.triedSteps.length ? (
                <BriefSection label="已尝试" icon="tried" items={briefing.triedSteps} />
              ) : null}
              {briefing.missingInformation.length ? (
                <BriefSection label="待确认" icon="missing" items={briefing.missingInformation} />
              ) : null}
              {briefing.unresolvedItems.length ? (
                <BriefSection label="未解决" icon="plain" items={briefing.unresolvedItems} />
              ) : null}
            </>
          ) : null}
        </View>
      </ScrollView>
    </Pressable>
  );
}

function BriefRow({
  icon,
  children,
}: {
  icon: "confirmed" | "next" | "reason" | "transfer";
  children: string;
}) {
  const styles = useThemedStyles(createStyles);
  const Icon =
    icon === "confirmed"
      ? CheckCircle
      : icon === "next"
        ? ArrowRight
        : icon === "reason"
          ? Warning
          : ArrowsLeftRight;
  return (
    <View style={styles.row}>
      <Icon size={16} color={styles.rowIcon.color} style={styles.rowIcon} />
      <Text style={styles.rowText}>{children}</Text>
    </View>
  );
}

function BriefSection({
  label,
  icon,
  items,
}: {
  label: string;
  icon: "tried" | "missing" | "plain";
  items: string[];
}) {
  const styles = useThemedStyles(createStyles);
  const Icon = icon === "tried" ? Wrench : icon === "missing" ? Question : null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {items.map((item, index) => (
        <View key={`${label}-${String(index)}`} style={styles.row}>
          {Icon ? (
            <Icon size={16} color={styles.rowIcon.color} style={styles.rowIcon} />
          ) : (
            <View style={styles.plainDot} />
          )}
          <Text style={styles.rowText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      marginHorizontal: 16,
      marginTop: 10,
      marginBottom: 6,
      padding: 12,
      backgroundColor: colors.paper,
      borderRadius: uiTokens.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
    },
    containerCollapsed: {
      backgroundColor: colors.subtle,
      borderRadius: uiTokens.radius.sm,
      paddingVertical: 9,
    },
    containerPressed: { backgroundColor: colors.blueWash },
    collapsedRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    collapsedTitle: {
      color: colors.ink,
      fontSize: 13,
      fontWeight: "600",
      flex: 1,
      opacity: 0.85,
    },
    collapsedChevron: { color: colors.muted },
    headlineRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
    headline: {
      color: colors.ink,
      fontSize: 15,
      lineHeight: 21,
      fontWeight: "700",
      flex: 1,
    },
    chevronDown: { marginTop: 4 },
    chevronUp: { marginTop: 4, transform: [{ rotate: "180deg" }] },
    meta: { color: colors.orange, fontSize: 11, lineHeight: 16, marginTop: 6 },
    expandedScroll: { maxHeight: 260 },
    body: { marginTop: 8, gap: 5 },
    row: { flexDirection: "row", alignItems: "flex-start", gap: 7 },
    rowIcon: { color: colors.muted, marginTop: 2 },
    rowText: { flex: 1, color: colors.ink, fontSize: 12, lineHeight: 18 },
    plainDot: {
      width: 4,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.muted,
      marginTop: 7,
      marginLeft: 6,
    },
    section: { marginTop: 6 },
    sectionLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: "600",
      marginBottom: 3,
    },
  });

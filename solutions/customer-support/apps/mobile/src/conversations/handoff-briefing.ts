import type { HandoffBriefing } from "./api";

export type HandoffBriefingViewModel = {
  briefVersion: number;
  headline: string;
  confirmedFacts: string[];
  triedSteps: string[];
  missingInformation: string[];
  unresolvedItems: string[];
  handoffReason: string;
  suggestedNextStep: string;
  suggestedFirstReply: string;
  sourceConversationRevision: number;
};

export function handoffBriefingViewModel(
  briefing: HandoffBriefing | null | undefined,
): HandoffBriefingViewModel | undefined {
  if (!briefing) return undefined;
  const legacy = briefing as HandoffBriefing & { sourceCaseRevision?: number };
  return {
    briefVersion: briefing.briefVersion,
    headline: briefing.problemSummary,
    confirmedFacts: briefing.confirmedFacts.map(
      (fact) => `${fact.label} · ${fact.value}`,
    ),
    triedSteps: briefing.triedSteps ?? [],
    missingInformation: briefing.missingInformation.map((item) => item.label),
    unresolvedItems: briefing.unresolvedItems,
    handoffReason: briefing.handoffReason ?? "",
    suggestedNextStep: briefing.suggestedNextStep ?? "",
    suggestedFirstReply: briefing.suggestedFirstReply,
    sourceConversationRevision:
      briefing.sourceConversationRevision ?? legacy.sourceCaseRevision ?? 0,
  };
}

/**
 * 兜底摘要：进行中的 handoff 缺少结构化 briefing（旧数据/生成失败）时，
 * 用 handoff 状态里可得的交接原因拼一个最小视图，避免出现「暂时不可用」死态。
 * sourceConversationRevision = 0 表示无版本事实，调用方不应显示过期条数。
 */
export function minimalHandoffBriefViewModel(
  reason?: string | null,
): HandoffBriefingViewModel {
  return {
    briefVersion: 0,
    headline: "客户需要人工继续处理",
    confirmedFacts: [],
    triedSteps: [],
    missingInformation: [],
    unresolvedItems: [],
    handoffReason: reason?.trim() || "",
    suggestedNextStep: "",
    suggestedFirstReply: "",
    sourceConversationRevision: 0,
  };
}

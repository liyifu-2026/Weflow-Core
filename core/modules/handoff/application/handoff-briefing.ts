/**
 * Human takeover briefing builder.
 *
 * Assembles a structured Handoff briefing from model-provided context.
 * The briefing is platform-level: it carries a problem summary, unresolved
 * items and a suggested first reply. Solution-specific fact labels are not
 * part of the platform contract.
 */

import type { HandoffBriefing } from "../../../infrastructure/postgres/schema.js";

type BuildHandoffBriefingInput = {
  sourceConversationRevision: number;
  handoffReason?: string;
  modelBriefing?: {
    problemSummary: string;
    unresolvedItems: string[];
    suggestedFirstReply: string;
  };
  generatedAt?: Date;
};

/** 构建人工接管简报，汇总模型提供的问题摘要、未解决事项和建议首条回复 */
export function buildHandoffBriefing(
  input: BuildHandoffBriefingInput,
): HandoffBriefing {
  const unresolvedItems = input.modelBriefing?.unresolvedItems.length
    ? input.modelBriefing.unresolvedItems
    : ["待人工核实当前问题"];
  return {
    version: 2,
    problemSummary:
      input.modelBriefing?.problemSummary ?? "当前会话需要人工继续处理。",
    confirmedFacts: [],
    triedSteps: [],
    missingInformation: [],
    unresolvedItems,
    handoffReason: input.handoffReason ?? "Agent 无法继续可靠处理当前问题。",
    suggestedNextStep: "根据现有会话上下文继续人工判断。",
    suggestedFirstReply:
      input.modelBriefing?.suggestedFirstReply ??
      "您好，我来继续处理这个问题。",
    sourceConversationRevision: input.sourceConversationRevision,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
  };
}

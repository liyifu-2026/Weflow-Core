/**
 * Briefing bridge for handoff creation paths that predate the v2 structured
 * brief (tool-recovery policy gate, auto-send disabled, global pause).
 *
 * 这些路径历史上不带 v2 简报：坐席接手后面对空白 cycle，而
 * transferMobileHandoff 对缺 v2 briefing 的会话一律 invalid_transition，
 * 导致接手者永远无法转交。桥接入口统一为这批路径补建机制级兜底简报
 * （平台中立文案，不含任何业务语义）。
 *
 * 简报是锦上添花：构建失败必须静默降级（返回 undefined = 无简报），
 * 绝不能让 handoff 创建本身失败——调用方一律 `...(briefing ? { briefing } : {})`。
 */
import type { HandoffBriefing } from "../../../infrastructure/postgres/schema.js";
import { buildHandoffBriefing } from "./handoff-briefing.js";

export function buildFallbackHandoffBriefing(input: {
  sourceConversationRevision: number;
  handoffReason: string;
  problemSummary?: string;
}): HandoffBriefing | undefined {
  try {
    return buildHandoffBriefing({
      sourceConversationRevision: input.sourceConversationRevision,
      handoffReason: input.handoffReason,
      ...(input.problemSummary
        ? {
            modelBriefing: {
              problemSummary: input.problemSummary,
              unresolvedItems: [],
              suggestedFirstReply: "",
            },
          }
        : {}),
    });
  } catch {
    // 静默降级：简报构建失败不拖垮转人工主路径。
    return undefined;
  }
}

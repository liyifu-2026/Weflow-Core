/**
 * Adapter from a Solution ExecutionStrategy AgentAction back into the
 * platform AgentDecision shape so the shared downstream pipeline can
 * process strategy-produced actions uniformly.
 */
import type { AgentAction } from "../contracts/execution-strategy.js";
import type { AgentDecision } from "./agent-decision.js";

/**
 * Maps a loaded Solution strategy AgentAction into the platform
 * AgentDecision shape. Only platform-level fields are carried over;
 * solution-specific metadata is intentionally dropped at this boundary.
 */
export function agentActionToDecision(action: AgentAction): AgentDecision {
  const nextAction =
    action.kind === "reply"
      ? "reply"
      : action.kind === "ask"
        ? "ask_for_information"
        : action.kind === "use_tool"
          ? "call_tool"
          : action.kind === "handoff"
            ? "handoff"
            : action.kind === "wait"
              ? "wait"
              : action.kind === "end_session"
                ? "end_session"
                : "no_action";

  const segments =
    action.kind === "reply" || action.kind === "ask"
      ? action.segments
      : (action.kind === "end_session" ||
            action.kind === "handoff" ||
            action.kind === "use_tool") &&
          action.segments
        ? action.segments
        : [];
  // reply/ask 可携带"说话并等待"参数（发完挂计时器）；纯 wait 同名字段。
  const carriedWaitMs =
    action.kind === "reply" || action.kind === "ask" || action.kind === "wait"
      ? action.waitMs
      : undefined;
  const carriedNudgeText =
    (action.kind === "reply" ||
      action.kind === "ask" ||
      action.kind === "wait") &&
    action.nudgeText
      ? action.nudgeText
      : undefined;

  return {
    replySegments: segments,
    replyText: segments.join("\n\n"),
    nextAction,
    // 策略经 meta 透传会话事实卡更新（unknown，处置层统一 sanitize）
    factsCard: (action.meta as Record<string, unknown> | undefined)
      ?.factsCard as Record<string, unknown> | undefined,
    // Strategy 的 reasonCode 为任意字符串；平台按原样传递（策略自身负责校验）
    noActionReason:
      action.kind === "no_action"
        ? (action.reasonCode as AgentDecision["noActionReason"])
        : undefined,
    requiresHuman: action.kind === "handoff",
    riskLevel: "low",
    waitMs: carriedWaitMs,
    nudgeText: carriedNudgeText,
    scheduledMessage: undefined,
    scheduledSendAt: undefined,
    closureSummary:
      action.kind === "end_session" ? action.closureSummary : undefined,
    handoffBriefing:
      action.kind === "handoff"
        ? {
            problemSummary: action.briefing.problemSummary,
            unresolvedItems: action.briefing.unresolvedItems,
            suggestedFirstReply: action.briefing.suggestedFirstReply,
          }
        : undefined,
    knowledgeQuery: undefined,
    tool:
      action.kind === "use_tool"
        ? {
            name: action.tool,
            arguments: action.arguments,
          }
        : undefined,
  };
}

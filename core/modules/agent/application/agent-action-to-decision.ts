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
            : "no_action";

  const segments =
    action.kind === "reply" || action.kind === "ask" ? action.segments : [];

  return {
    replySegments: segments,
    replyText: segments.join("\n\n"),
    nextAction,
    // Strategy 的 reasonCode 为任意字符串；平台按原样传递（策略自身负责校验）
    noActionReason:
      action.kind === "no_action"
        ? (action.reasonCode as AgentDecision["noActionReason"])
        : undefined,
    requiresHuman: action.kind === "handoff",
    riskLevel: "low",
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

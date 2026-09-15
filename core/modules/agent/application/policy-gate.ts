import { MAX_REPLY_SEGMENTS } from "./decision-contract.js";
import type { AgentDecision } from "./agent-decision.js";
import { normalizeReplyText } from "./reply-text.js";

export type GateOutcome =
  { action: "allow" } | { action: "handoff"; reasonCode: string };

/**
 * Generic decision gate.
 *
 * The gate enforces platform-level boundaries only: when the model itself
 * flags the turn for human takeover (explicit handoff, high risk, or
 * requires_human), the platform routes to handoff. Solution-specific safety
 * rules belong in an ExecutionStrategy's validateAction hook, not here.
 */
export function validateDecision(decision: AgentDecision): GateOutcome {
  if (
    decision.requiresHuman ||
    decision.riskLevel === "high" ||
    decision.nextAction === "handoff"
  ) {
    return { action: "handoff", reasonCode: "model_requested_handoff" };
  }
  return { action: "allow" };
}

export function validateReplySegments(segments: string[]): string[] {
  const cleaned = segments.map((segment) => segment.trim()).filter(Boolean);
  if (cleaned.length < 1 || cleaned.length > MAX_REPLY_SEGMENTS) {
    throw new Error("reply_segment_count_invalid");
  }
  if (cleaned.some((segment) => segment.length > 500)) {
    throw new Error("reply_segment_too_long");
  }
  return cleaned;
}

/**
 * 批内逐字重复段（模型复读自己）：保留首条，按归一化文本比较。
 *
 * 必须在**落库边界**调用（`createAgentReply`），不能只挂在
 * `validateReplySegments` 上——主回复路径只把校验当「会不会抛」的副作用用，
 * 返回值被丢弃；跨批守卫（duplicate-reply）又只看「整批 vs 上一条批次」，
 * 看不见批内两条一模一样的话。两边都够不着时，那两条会按打字节拍各发
 * 一次，客户侧就是「同一条消息发了两遍」。
 */
export function dedupeReplySegments(segments: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const segment of segments) {
    const key = normalizeReplyText(segment);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(segment);
  }
  return result;
}

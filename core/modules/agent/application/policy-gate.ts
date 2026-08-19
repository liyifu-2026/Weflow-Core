import type { AgentDecision } from "./agent-decision.js";

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
  if (cleaned.length < 1 || cleaned.length > 3) {
    throw new Error("reply_segment_count_invalid");
  }
  if (cleaned.some((segment) => segment.length > 500)) {
    throw new Error("reply_segment_too_long");
  }
  return cleaned;
}

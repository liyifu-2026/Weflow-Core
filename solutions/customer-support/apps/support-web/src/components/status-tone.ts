export type WfStatusTone =
  "good" | "warn" | "bad" | "accent" | "neutral" | "inactive";

const positive = new Set([
  "active",
  "completed",
  "healthy",
  "passed",
  "published",
  "ready",
  "resolved",
  "success",
]);
const warning = new Set([
  "degraded",
  "medium",
  "pending",
  "processing",
  "queued",
  "running",
]);
const danger = new Set([
  "error",
  "failed",
  "high",
  "unavailable",
  "unreachable",
]);
const accent = new Set(["draft", "in_progress"]);
const inactive = new Set(["disabled", "retired"]);

export function statusTone(value?: string | null): WfStatusTone {
  const state = value?.toLowerCase() || "";
  if (positive.has(state)) return "good";
  if (warning.has(state)) return "warn";
  if (danger.has(state)) return "bad";
  if (accent.has(state)) return "accent";
  if (inactive.has(state)) return "inactive";
  return "neutral";
}

export function validationTone(input?: {
  status?: string;
  passed?: boolean;
}): WfStatusTone {
  if (!input?.status) return "neutral";
  if (input.status === "queued" || input.status === "running") return "warn";
  if (input.status === "completed") return input.passed ? "good" : "bad";
  return statusTone(input.status);
}


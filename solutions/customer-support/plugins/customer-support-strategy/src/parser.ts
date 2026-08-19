import type {
  AgentAction,
  AgentActionMeta,
  HandoffBriefing,
} from "@weflow/contracts";

/**
 * Customer Support model response parser.
 *
 * This is a self-contained parser migrated from Core's decision schema. It
 * currently supports the primary AgentAction mapping; richer validation can be
 * added without touching Core.
 */
export function parseCustomerSupportResponse(text: string): AgentAction {
  const candidate = extractJsonObject(text);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    throw new Error("invalid customer support model response");
  }

  const nextAction = raw.next_action;
  const segments = normalizeSegments(raw.reply_segments, raw.reply_text);
  const meta = buildMeta(raw);

  switch (nextAction) {
    case "reply":
      if (segments.length === 0) {
        throw new Error("reply action requires reply_segments or reply_text");
      }
      return { kind: "reply", segments, ...(meta ? { meta } : {}) };
    case "ask_for_information":
      return {
        kind: "ask",
        segments,
        requestedFacts: normalizeStringArray(raw.missing_fields),
        ...(meta ? { meta } : {}),
      };
    case "call_tool": {
      const tool = asRecord(raw.tool);
      if (typeof tool?.name !== "string") {
        throw new Error("call_tool action requires tool.name");
      }
      return {
        kind: "use_tool",
        tool: tool.name,
        arguments: asStringRecord(tool.arguments),
        ...(meta ? { meta } : {}),
      };
    }
    case "handoff": {
      const briefing = asRecord(raw.handoff_briefing);
      return {
        kind: "handoff",
        reasonCode:
          typeof raw.no_action_reason === "string"
            ? raw.no_action_reason
            : "handoff",
        briefing: normalizeBriefing(briefing),
        ...(meta ? { meta } : {}),
      };
    }
    case "no_action":
      return {
        kind: "no_action",
        reasonCode:
          typeof raw.no_action_reason === "string"
            ? raw.no_action_reason
            : "no_action",
        ...(meta ? { meta } : {}),
      };
    default:
      throw new Error(`unsupported next_action: ${String(nextAction)}`);
  }
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("invalid customer support model response");
  }
  return withoutFence.slice(start, end + 1);
}

function normalizeSegments(
  segments: unknown,
  replyText: unknown,
): string[] {
  if (Array.isArray(segments)) {
    const result = segments.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    if (result.length > 0) return result;
  }
  if (typeof replyText === "string" && replyText.trim().length > 0) {
    return [replyText.trim()];
  }
  return [];
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

function normalizeBriefing(
  value: Record<string, unknown> | null,
): HandoffBriefing {
  const problemSummary =
    typeof value?.problem_summary === "string"
      ? value.problem_summary
      : typeof value?.problemSummary === "string"
        ? value.problemSummary
        : "";
  const unresolvedItems = normalizeStringArray(
    value?.unresolved_items ?? value?.unresolvedItems,
  );
  const suggestedFirstReply =
    typeof value?.suggested_first_reply === "string"
      ? value.suggested_first_reply
      : typeof value?.suggestedFirstReply === "string"
        ? value.suggestedFirstReply
        : "";
  return {
    reasonCode: "handoff",
    problemSummary,
    unresolvedItems,
    suggestedFirstReply,
  };
}

function buildMeta(raw: Record<string, unknown>): AgentActionMeta | undefined {
  const meta: AgentActionMeta = {};
  if (typeof raw.intent === "string") meta.intent = raw.intent;
  if (typeof raw.stage === "string") meta.stage = raw.stage;
  if (Array.isArray(raw.missing_fields)) {
    meta.missingFields = normalizeStringArray(raw.missing_fields);
  }
  if (isRecord(raw.extracted_facts)) {
    const extracted: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.extracted_facts)) {
      if (typeof value === "string") extracted[key] = value;
    }
    if (Object.keys(extracted).length > 0) meta.extractedFacts = extracted;
  }
  if (Array.isArray(raw.facts_to_store)) {
    meta.factsToStore = raw.facts_to_store.flatMap((item) => {
      const record = asRecord(item);
      if (!record || typeof record.field !== "string") return [];
      return [
        {
          field: record.field,
          ...(typeof record.subject === "string"
            ? { subject: record.subject }
            : {}),
          ...(typeof record.value === "string" ? { value: record.value } : {}),
          status:
            typeof record.status === "string" ? record.status : "confirmed",
          source:
            typeof record.source === "string" ? record.source : "customer",
          ...(typeof record.granularity === "string"
            ? { granularity: record.granularity }
            : {}),
        },
      ];
    });
  }
  if (Array.isArray(raw.questions)) {
    meta.questions = raw.questions.flatMap((item) => {
      const record = asRecord(item);
      if (!record || typeof record.field !== "string") return [];
      return [
        {
          field: record.field,
          ...(typeof record.subject === "string"
            ? { subject: record.subject }
            : {}),
          reason: typeof record.reason === "string" ? record.reason : "missing",
          ...(typeof record.requires_granularity === "string"
            ? { requiresGranularity: record.requires_granularity }
            : {}),
        },
      ];
    });
  }
  if (Array.isArray(raw.actions)) {
    meta.actions = raw.actions.flatMap((item) => {
      const record = asRecord(item);
      if (!record || typeof record.action !== "string") return [];
      return [
        {
          action: record.action,
          result: typeof record.result === "string" ? record.result : "suggested",
          ...(typeof record.subject === "string"
            ? { subject: record.subject }
            : {}),
        },
      ];
    });
  }
  if (Array.isArray(raw.claims)) {
    meta.claims = raw.claims.flatMap((item) => {
      const record = asRecord(item);
      if (!record || typeof record.type !== "string") return [];
      return [
        {
          type: record.type,
          evidenceId:
            typeof record.evidence_id === "string" ? record.evidence_id : "",
        },
      ];
    });
  }
  if (typeof raw.active_issue_changed === "boolean") {
    meta.activeIssueChanged = raw.active_issue_changed;
  }
  if (typeof raw.requires_human === "boolean") {
    meta.requiresHuman = raw.requires_human;
  }
  if (raw.risk_level === "low" || raw.risk_level === "medium" || raw.risk_level === "high") {
    meta.riskLevel = raw.risk_level;
  }
  const briefing = asRecord(raw.handoff_briefing);
  if (briefing) {
    meta.handoffBriefing = {
      problemSummary:
        typeof briefing.problem_summary === "string"
          ? briefing.problem_summary
          : typeof briefing.problemSummary === "string"
            ? briefing.problemSummary
            : "",
      unresolvedItems: normalizeStringArray(
        briefing.unresolved_items ?? briefing.unresolvedItems,
      ),
      suggestedFirstReply:
        typeof briefing.suggested_first_reply === "string"
          ? briefing.suggested_first_reply
          : typeof briefing.suggestedFirstReply === "string"
            ? briefing.suggestedFirstReply
            : "",
    };
  }
  if (typeof raw.knowledge_query === "string") {
    meta.knowledgeQuery = raw.knowledge_query;
  }
  if (typeof raw.no_action_reason === "string") {
    meta.noActionReason = raw.no_action_reason;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

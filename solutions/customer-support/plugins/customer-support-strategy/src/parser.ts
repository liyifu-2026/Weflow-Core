import type {
  AgentAction,
  AgentActionMeta,
  HandoffBriefing,
} from "@weflow-leaif/contracts";
import { DEFAULT_REPLY_WAIT_MS, WAIT_MS } from "./decision-protocol.js";

/**
 * 本包安装的是 npm 版 @weflow-leaif/contracts@1.0.0，尚不认识
 * wait / end_session / reply.waitMs（平台侧 packages/contracts 已扩）。
 * 在此以结构兼容的本地类型过渡；运行时对象与平台新契约一致，
 * contracts 发版后可删。
 */
export type CustomerSupportAgentAction =
  | AgentAction
  | {
      kind: "wait";
      waitMs: number;
      nudgeText?: string;
      meta?: AgentActionMeta;
    }
  | {
      kind: "end_session";
      closureSummary: string;
      segments?: string[];
      meta?: AgentActionMeta;
    }
  | {
      // 平台契约已扩 handoff.segments（转接前告别话术）；npm contracts 发版前
      // 在此以结构兼容的本地变体过渡，与 wait/end_session 同理。
      kind: "handoff";
      reasonCode: string;
      briefing: HandoffBriefing;
      segments?: string[];
      meta?: AgentActionMeta;
    };

/** 工具动作附带的过程性短讯（≤2 条，平台软闸同域）；空数组归一为缺省。 */
function toolNoteSegments(segments: string[]): string[] | undefined {
  return segments.length > 0 ? segments.slice(0, 2) : undefined;
}

/** wait_ms 合法域来自 decision-protocol（单一事实源）；模型漏给时回落 fallback。 */
const WAIT_MS_MIN = WAIT_MS.min;
const WAIT_MS_MAX = WAIT_MS.max;
const WAIT_MS_FALLBACK = WAIT_MS.fallback;

function clampWaitMs(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return WAIT_MS_FALLBACK;
  return Math.min(WAIT_MS_MAX, Math.max(WAIT_MS_MIN, Math.round(num)));
}

/** parseCustomerSupportResponse 的可选策略（默认取业务默认值，见下） */
export type ParseCustomerSupportOptions = {
  /**
   * reply / ask_for_information 缺 wait_ms 时的业务默认等待毫秒。
   * 省略 = DEFAULT_REPLY_WAIT_MS；null 或 ≤0 = 沿用引擎语义（继续说）。
   */
  defaultReplyWaitMs?: number | null | undefined;
};

/**
 * reply / ask 的等待时长：显式 wait_ms 优先；缺省补业务默认。
 *
 * 引擎把「不带 wait_ms」读作「本回合还要继续工作」，客服场景里这会让模型
 * 在几乎相同的上下文里续步复读同一步骤（实测：换 USB 口那条发了三遍）。
 * 缺省补齐为「说完交权」，让每一步都停在客户反馈上。
 */
function resolveReplyWaitMs(
  waitMs: number | undefined,
  options: ParseCustomerSupportOptions,
): number | undefined {
  if (waitMs !== undefined) return waitMs;
  const configured =
    options.defaultReplyWaitMs === undefined
      ? DEFAULT_REPLY_WAIT_MS
      : options.defaultReplyWaitMs;
  if (configured === null || !Number.isFinite(configured) || configured <= 0) {
    return undefined;
  }
  return clampWaitMs(configured);
}

/**
 * Customer Support model response parser.
 *
 * This is a self-contained parser migrated from Core's decision schema. It
 * currently supports the primary AgentAction mapping; richer validation can
 * be added without touching Core.
 */
export function parseCustomerSupportResponse(
  text: string,
  options: ParseCustomerSupportOptions = {},
): CustomerSupportAgentAction {
  const candidate = extractJsonObject(text);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    throw new Error("invalid customer support model response");
  }

  const nextAction = raw.next_action;
  // 视觉模型偶发把回复直接放在 reply 键下（{"reply":"..."} 而非
  // next_action+reply_segments），作为等价文案来源兜住，避免好回复被静默。
  const segments = normalizeSegments(
    raw.reply_segments,
    raw.reply_text ?? raw.reply,
  );
  const meta = buildMeta(raw);
  const waitMs = hasWaitMs(raw) ? clampWaitMs(raw.wait_ms) : undefined;
  const replyWaitMs = resolveReplyWaitMs(waitMs, options);
  const nudgeText = normalizeNudgeText(raw);

  switch (nextAction) {
    case "reply":
      if (segments.length === 0) {
        throw new Error("reply action requires reply_segments or reply_text");
      }
      return {
        kind: "reply",
        segments,
        ...(replyWaitMs !== undefined ? { waitMs: replyWaitMs } : {}),
        ...(nudgeText ? { nudgeText } : {}),
        ...(meta ? { meta } : {}),
      };
    case "ask_for_information":
      return {
        kind: "ask",
        segments,
        requestedFacts: normalizeStringArray(raw.missing_fields),
        ...(replyWaitMs !== undefined ? { waitMs: replyWaitMs } : {}),
        ...(nudgeText ? { nudgeText } : {}),
        ...(meta ? { meta } : {}),
      };
    case "retrieve_knowledge": {
      const query =
        typeof raw.knowledge_query === "string"
          ? raw.knowledge_query.trim()
          : "";
      if (!query) {
        throw new Error("retrieve_knowledge action requires knowledge_query");
      }
      const notes = toolNoteSegments(segments);
      return {
        kind: "use_tool",
        tool: "retrieve_knowledge",
        arguments: { query },
        ...(notes ? { segments: notes } : {}),
        ...(meta ? { meta } : {}),
      };
    }
    case "call_tool": {
      const tool = asRecord(raw.tool);
      if (typeof tool?.name !== "string") {
        throw new Error("call_tool action requires tool.name");
      }
      const notes = toolNoteSegments(segments);
      return {
        kind: "use_tool",
        tool: tool.name,
        arguments: asStringRecord(tool.arguments),
        ...(notes ? { segments: notes } : {}),
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
        ...(segments.length > 0 ? { segments } : {}),
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
    case "wait":
      return {
        kind: "wait",
        waitMs: waitMs ?? WAIT_MS_FALLBACK,
        ...(nudgeText ? { nudgeText } : {}),
        ...(meta ? { meta } : {}),
      };
    case "end_session": {
      const closureSummary =
        typeof raw.closure_summary === "string"
          ? raw.closure_summary.trim()
          : "";
      return {
        kind: "end_session",
        closureSummary,
        ...(segments.length > 0 ? { segments } : {}),
        ...(meta ? { meta } : {}),
      };
    }
    // 模型 JSON 合法但 next_action 缺失/未知（视觉模型长提示下偶发丢键）：
    // 若夹带了可读回复文本，按 reply 发出并保留 wait_ms/nudge_text（否则
    // 回复发出后脱离等待节拍，客户不回就沉底）；否则静默 no_action（原因
    // 标记 unparsed_model_output），绝不抛致命错误触发整轮失败重试转人工。
    default: {
      if (segments.length > 0) {
        return {
          kind: "reply",
          segments,
          ...(replyWaitMs !== undefined ? { waitMs: replyWaitMs } : {}),
          ...(nudgeText ? { nudgeText } : {}),
          ...(meta ? { meta } : {}),
        };
      }
      return {
        kind: "no_action",
        reasonCode: "unparsed_model_output",
        ...(meta ? { meta } : {}),
      };
    }
  }
}

function hasWaitMs(raw: Record<string, unknown>): boolean {
  return raw.wait_ms !== undefined && raw.wait_ms !== null;
}

function normalizeNudgeText(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.nudge_text !== "string") return undefined;
  const trimmed = raw.nudge_text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

function normalizeSegments(segments: unknown, replyText: unknown): string[] {
  if (Array.isArray(segments)) {
    // 兼容视觉模型偶发的结构化段（{type:"text", content|text}），
    // 与纯字符串段统一提取为文本（探针实测 vision-exp 曾返回对象段）。
    const result = segments
      .map(segmentToText)
      .filter((item): item is string => Boolean(item));
    if (result.length > 0) return result;
  }
  // 兼容模型偶发把 reply_segments 直接写成字符串（实测 11:23 场景）。
  if (typeof segments === "string" && segments.trim().length > 0) {
    return [segments.trim()];
  }
  if (typeof replyText === "string" && replyText.trim().length > 0) {
    return [replyText.trim()];
  }
  return [];
}

/** 单段文本提取：字符串原样；对象取 content/text（仅 text 类型）。 */
function segmentToText(item: unknown): string | null {
  if (typeof item === "string") return item.trim() || null;
  if (typeof item !== "object" || item === null || Array.isArray(item))
    return null;
  const record = item as Record<string, unknown>;
  if (typeof record.type === "string" && record.type !== "text") return null;
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.text === "string"
        ? record.text
        : "";
  return content.trim() || null;
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
  if (typeof raw.requires_human === "boolean") {
    meta.requiresHuman = raw.requires_human;
  }
  if (
    raw.risk_level === "low" ||
    raw.risk_level === "medium" ||
    raw.risk_level === "high"
  ) {
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
  // 会话事实卡更新：平台处置层统一 sanitize 后落库，下回合注入上下文
  if (typeof raw.facts_card === "object" && raw.facts_card !== null) {
    meta.factsCard = raw.facts_card;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

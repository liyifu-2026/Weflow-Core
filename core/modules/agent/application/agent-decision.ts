/**
 * Generic Agent decision parsing.
 *
 * Defines the JSON Schema for LLM-produced decisions and validates model
 * output. The schema is intentionally platform-level: no solution-specific
 * fields (intent, stage, case facts, questions, action claims, ...) live here.
 * Solutions that need richer decisions provide their own ExecutionStrategy
 * (see contracts/execution-strategy.ts) with its own schema.
 */

import { z } from "zod";
import {
  MAX_REPLY_SEGMENTS,
  NEXT_ACTION_VALUES,
  NO_ACTION_REASONS,
  WAIT_MS_RANGE,
  SCHEDULE_SEND_RANGE,
} from "./decision-contract.js";

/** LLM 输出的原始 JSON Schema（snake_case 字段，与提示词对齐）
 *
 * 长度上限采取「宽松受理 + 收敛」而非 strict 拒绝：模型输出略超限
 * （facts_card 多写一条、reply_text 超过单段 500 字）曾直接炸掉整个
 * 决策 → 重试 3 次耗尽转人工，与 sanitize「宁可残缺不可阻断」的契约
 * 相悖。此处只拒绝结构性错误（未知动作码、缺必填字段），量的问题交给
 * transform 拆分/截断与处置层 sanitize。 */
const decisionInputSchema = z
  .object({
    reply_text: z.string().trim().min(1).max(4_000).optional(),
    reply_segments: z
      .array(z.string().trim().min(1).max(2_000))
      .min(1)
      .max(MAX_REPLY_SEGMENTS * 4)
      .optional(),
    next_action: z.enum(NEXT_ACTION_VALUES),
    no_action_reason: z.enum(NO_ACTION_REASONS).optional(),
    requires_human: z.boolean(),
    risk_level: z.enum(["low", "medium", "high"]),
    handoff_briefing: z
      .object({
        problem_summary: clampString(1_000),
        unresolved_items: z.array(clampString(500)).max(40).optional(),
        suggested_first_reply: clampString(1_000),
      })
      .optional(),
    knowledge_query: z.string().trim().min(1).max(1_000).optional(),
    tool: z
      .object({
        name: z.string().trim().min(1).max(80),
        arguments: z.record(z.string(), z.string()).default({}),
      })
      .optional(),
    wait_ms: z
      .number()
      .int()
      .min(WAIT_MS_RANGE.min)
      .max(WAIT_MS_RANGE.max)
      .optional(),
    nudge_text: z.string().trim().min(1).max(500).optional(),
    scheduled_message: z
      .string()
      .trim()
      .min(1)
      .max(SCHEDULE_SEND_RANGE.maxContentLength)
      .optional(),
    scheduled_send_at: z.string().trim().min(1).max(40).optional(),
    closure_summary: z.string().trim().min(1).max(1_000).optional(),
    // 会话事实卡（私聊批）：模型对持久工作状态的全量更新；咨询性数据，
    // 处置层经 sanitize 收敛后落 agent.fact_cards，下回合开头注入。
    // 未知键剥离、超限截断（不 strict：多写一个键就炸整轮的代价远大于收益）。
    facts_card: z
      .object({
        problem: clampString(500).optional(),
        confirmed_facts: z.array(clampString(200)).max(40).optional(),
        attempted: z.array(clampString(200)).max(40).optional(),
        promises: z.array(clampString(200)).max(40).optional(),
        open_questions: z.array(clampString(200)).max(40).optional(),
      })
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // 根据 next_action 类型校验必需字段
    const replyRequired = ![
      "retrieve_knowledge",
      // call_tool 可选附带 ≤2 条过程短讯（说+做同发），不强制
      "call_tool",
      "handoff",
      "no_action",
      "wait",
      "end_session",
      // schedule_send 的即时确认回复可选：模型可"只约定不定论"
      "schedule_send",
    ].includes(value.next_action);
    if (replyRequired && !value.reply_text && !value.reply_segments) {
      context.addIssue({
        code: "custom",
        path: ["reply_segments"],
        message: "reply_text or reply_segments is required",
      });
    }
    if (value.next_action === "call_tool" && !value.tool) {
      context.addIssue({
        code: "custom",
        path: ["tool"],
        message: "tool is required when next_action is call_tool",
      });
    }
    if (value.next_action === "retrieve_knowledge" && !value.knowledge_query) {
      context.addIssue({
        code: "custom",
        path: ["knowledge_query"],
        message: "knowledge_query is required when retrieving knowledge",
      });
    }
    if (value.next_action === "no_action" && !value.no_action_reason) {
      context.addIssue({
        code: "custom",
        path: ["no_action_reason"],
        message: "no_action_reason is required when no_action",
      });
    }
    if (value.next_action === "wait" && !value.wait_ms) {
      context.addIssue({
        code: "custom",
        path: ["wait_ms"],
        message: "wait_ms is required when next_action is wait",
      });
    }
    if (value.next_action === "end_session" && !value.closure_summary) {
      context.addIssue({
        code: "custom",
        path: ["closure_summary"],
        message: "closure_summary is required when next_action is end_session",
      });
    }
    if (value.next_action === "schedule_send") {
      if (!value.scheduled_message) {
        context.addIssue({
          code: "custom",
          path: ["scheduled_message"],
          message:
            "scheduled_message is required when next_action is schedule_send",
        });
      }
      if (!value.scheduled_send_at) {
        context.addIssue({
          code: "custom",
          path: ["scheduled_send_at"],
          message:
            "scheduled_send_at is required when next_action is schedule_send",
        });
      } else {
        const sendAt = Date.parse(value.scheduled_send_at);
        if (!Number.isFinite(sendAt)) {
          context.addIssue({
            code: "custom",
            path: ["scheduled_send_at"],
            message: "scheduled_send_at must be an ISO 8601 datetime",
          });
        } else {
          const ahead = sendAt - Date.now();
          if (
            ahead < SCHEDULE_SEND_RANGE.minAheadMs ||
            ahead > SCHEDULE_SEND_RANGE.maxAheadMs
          ) {
            context.addIssue({
              code: "custom",
              path: ["scheduled_send_at"],
              message: `scheduled_send_at must be 1 minute to 30 days in the future`,
            });
          }
        }
      }
    }
  });

/** 受理宽松、落点收敛：超长字符串截断（嵌套对象 schema 用，不拒绝） */
function clampString(max: number) {
  return z.string().transform((value) => value.trim().slice(0, max));
}

/**
 * 把超过单段上限的回复拆成 ≤500 字的多段。
 * 501–2000 字的合法长回复过去直接炸段校验（reply_segment_too_long）→
 * 整轮静默 failed：不回复、也不转人工。现在在契约层拆分，优先在
 * 标点/空白处断开避免句子腰斩；拆出的段数超出上限时截断并标记省略号
 * （降级为部分送达，仍好过整轮沉默）。
 */
function splitSegment(segment: string, max = 500): string[] {
  if (segment.length <= max) return [segment];
  const chunks: string[] = [];
  let rest = segment.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const candidates = [
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf("；"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    ].filter((index) => index >= max - 120);
    const cut = candidates.length > 0 ? Math.max(...candidates) + 1 : max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter((chunk) => chunk.length > 0);
}

/** 将 LLM 输出的 snake_case 字段转换为内部 camelCase 格式 */
const decisionSchema = decisionInputSchema.transform((value) => {
  const rawSegments = value.reply_segments ?? [value.reply_text ?? ""];
  const split = rawSegments.flatMap((segment) => splitSegment(segment));
  const replySegments =
    split.length > MAX_REPLY_SEGMENTS
      ? [
          ...split.slice(0, MAX_REPLY_SEGMENTS - 1),
          `${split[MAX_REPLY_SEGMENTS - 1]}…`,
        ]
      : split;
  return {
    replySegments,
    replyText: replySegments.join("\n\n"),
    nextAction: value.next_action,
    noActionReason: value.no_action_reason,
    requiresHuman: value.requires_human,
    riskLevel: value.risk_level,
    tool: value.tool,
    knowledgeQuery: value.knowledge_query,
    waitMs: value.wait_ms,
    nudgeText: value.nudge_text,
    scheduledMessage: value.scheduled_message,
    scheduledSendAt: value.scheduled_send_at
      ? new Date(value.scheduled_send_at)
      : undefined,
    closureSummary: value.closure_summary,
    // 放宽为 Record：策略路径经 meta 透传（unknown），处置层统一 sanitize
    factsCard: value.facts_card as Record<string, unknown> | undefined,
    handoffBriefing: value.handoff_briefing
      ? {
          problemSummary: value.handoff_briefing.problem_summary,
          unresolvedItems: value.handoff_briefing.unresolved_items ?? [],
          suggestedFirstReply: value.handoff_briefing.suggested_first_reply,
        }
      : undefined,
  };
});

/** Agent 决策的内部类型（camelCase） */
export type AgentDecision = z.infer<typeof decisionSchema>;

/**
 * 解析 LLM 返回的决策文本
 * 处理可能的 Markdown 围栏等边界情况；未知字段被 strict schema 拒绝。
 */
export function parseAgentDecision(responseText: string): AgentDecision {
  const candidate = extractJsonObject(responseText);
  try {
    const raw = JSON.parse(candidate) as Record<string, unknown>;
    if (Array.isArray(raw.reply_segments) && raw.reply_segments.length === 0) {
      delete raw.reply_segments;
    }
    return decisionSchema.parse(raw);
  } catch (error) {
    throw new Error("invalid agent decision", { cause: error });
  }
}

/** 从 LLM 响应文本中提取 JSON 对象字符串，去除可能的 Markdown 围栏 */
function extractJsonObject(responseText: string): string {
  const trimmed = responseText.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("invalid agent decision");
  }
  return withoutFence.slice(start, end + 1);
}

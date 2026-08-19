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

/** LLM 输出的原始 JSON Schema（snake_case 字段，与提示词对齐） */
const decisionInputSchema = z
  .object({
    reply_text: z.string().trim().min(1).max(2_000).optional(),
    reply_segments: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(3)
      .optional(),
    next_action: z.enum([
      "reply",
      "ask_for_information",
      "retrieve_knowledge",
      "call_tool",
      "handoff",
      "no_action",
    ]),
    no_action_reason: z
      .enum([
        "message_not_actionable",
        "waiting_for_user",
        "duplicate_event",
        "handoff_active",
        "agent_disabled",
        "superseded",
        "policy_suppressed",
      ])
      .optional(),
    requires_human: z.boolean(),
    risk_level: z.enum(["low", "medium", "high"]),
    handoff_briefing: z
      .object({
        problem_summary: z.string().trim().min(1).max(1_000),
        unresolved_items: z.array(z.string().trim().min(1).max(500)).max(20),
        suggested_first_reply: z.string().trim().min(1).max(1_000),
      })
      .strict()
      .optional(),
    knowledge_query: z.string().trim().min(1).max(1_000).optional(),
    tool: z
      .object({
        name: z.string().trim().min(1).max(80),
        arguments: z.record(z.string(), z.string()).default({}),
      })
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // 根据 next_action 类型校验必需字段
    const replyRequired = ![
      "retrieve_knowledge",
      "handoff",
      "no_action",
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
  });

/** 将 LLM 输出的 snake_case 字段转换为内部 camelCase 格式 */
const decisionSchema = decisionInputSchema.transform((value) => ({
  replySegments: value.reply_segments ?? [value.reply_text ?? ""],
  replyText: (value.reply_segments ?? [value.reply_text ?? ""]).join("\n\n"),
  nextAction: value.next_action,
  noActionReason: value.no_action_reason,
  requiresHuman: value.requires_human,
  riskLevel: value.risk_level,
  tool: value.tool,
  knowledgeQuery: value.knowledge_query,
  handoffBriefing: value.handoff_briefing
    ? {
        problemSummary: value.handoff_briefing.problem_summary,
        unresolvedItems: value.handoff_briefing.unresolved_items,
        suggestedFirstReply: value.handoff_briefing.suggested_first_reply,
      }
    : undefined,
}));

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

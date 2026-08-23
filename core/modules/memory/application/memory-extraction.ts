/**
 * 记忆提取工具
 *
 * 提供 LLM 记忆提取的 prompt 构建、响应解析和验证功能。
 * 从会话消息中提取联系人的事实、偏好和关系信息，
 * 并对敏感信息进行自动检测和标记。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { TextModelError } from "../../model/contracts/text-model-error.js";
import type { TextModel } from "../../model/contracts/text-model.js";
import type { TextModelMessage } from "../../model/contracts/text-generation-request.js";

const candidateSchema = z
  .object({
    kind: z.enum(["fact", "preference", "relationship"]),
    key: z
      .string()
      .trim()
      .regex(/^[a-z0-9_.-]{1,100}$/),
    content: z.string().trim().min(1).max(500),
    confidence: z.number().int().min(0).max(100),
    importance: z.number().int().min(1).max(5).default(3),
    evidenceMessageIds: z.array(z.string().min(1).max(600)).min(1).max(20),
    subject: z.enum(["contact", "other", "unclear"]),
    explicit: z.boolean(),
    stable: z.boolean(),
    sensitive: z.boolean(),
  })
  .strict();

const extractionSchema = z
  .object({ memories: z.array(candidateSchema).max(10) })
  .strict();

/** 从 LLM 响应中提取的单条记忆结构 */
export type ExtractedMemory = z.infer<typeof candidateSchema>;

/** 构建记忆提取的 LLM prompt（系统提示 + 消息上下文） */
export function memoryExtractionPrompt(
  messages: {
    messageId: string;
    direction: string;
    actorType: string;
    text: string;
  }[],
): TextModelMessage[] {
  return [
    {
      role: "system",
      content:
        '你是 Weflow 的长期记忆提取器。只提取联系人本人明确表达、跨轮仍有用的事实、偏好或关系。忽略临时情绪、寒暄、助手说的话、关于他人的转述和推测。敏感信息必须标 sensitive=true。key 必须是简短英文 snake_case。importance 表示这条记忆对长期服务客户的重要程度：1=很低，2=低，3=普通，4=重要，5=关键。只返回 JSON，不要 Markdown：{"memories":[{"kind":"fact|preference|relationship","key":"...","content":"...","confidence":0,"importance":3,"evidenceMessageIds":["..."],"subject":"contact|other|unclear","explicit":true,"stable":true,"sensitive":false}]}',
    },
    {
      role: "user",
      content: JSON.stringify({ messages }),
    },
  ];
}

/** Execute structured extraction without exposing a provider implementation. */
export async function extractMemories(
  model: TextModel,
  messages: {
    messageId: string;
    direction: string;
    actorType: string;
    text: string;
  }[],
): Promise<ExtractedMemory[]> {
  const result = await model.generate({
    messages: memoryExtractionPrompt(messages),
    output: "structured",
  });
  return parseMemoryExtraction(result.text);
}

/** 解析 LLM 返回的记忆提取 JSON 文本 */
export function parseMemoryExtraction(text: string): ExtractedMemory[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("memory extraction did not return a JSON object");
  }
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  return extractionSchema.parse(parsed).memories;
}

/**
 * 判断记忆的发布状态
 *
 * 满足所有条件（联系人本人、明确表达、稳定、非敏感、置信度 >= 90）
 * 的记忆直接标记为 active，否则为 candidate（待人工审核）。
 */
export function publishedStatus(
  memory: ExtractedMemory,
): "active" | "candidate" {
  return memory.subject === "contact" &&
    memory.explicit &&
    memory.stable &&
    !isSensitiveMemory(memory) &&
    memory.confidence >= 90
    ? "active"
    : "candidate";
}

function isSensitiveMemory(memory: ExtractedMemory): boolean {
  if (memory.sensitive) return true;
  const sensitiveKey =
    /(?:health|medical|diagnosis|religion|politic|income|salary|id_number|bank|phone|email|address|sexual|biometric)/i;
  const sensitiveContent =
    /(?:身份证|银行卡|病史|诊断|抑郁|收入|工资|住址|手机号|邮箱|宗教|政治倾向)/;
  return sensitiveKey.test(memory.key) || sensitiveContent.test(memory.content);
}

/** 根据联系人 ID、类型、键和内容生成确定性记忆 ID */
export function memoryIdFor(
  contactId: string,
  kind: string,
  key: string,
  content: string,
): string {
  const digest = createHash("sha256")
    .update(`${contactId}\0${kind}\0${key}\0${content}`)
    .digest("hex");
  return `memory_${digest}`;
}

/** Preserve Memory's existing durable error-code vocabulary at the application boundary. */
export function memoryCaptureErrorCode(error: unknown): string {
  if (error instanceof SyntaxError) return "invalid_model_json";
  if (error instanceof Error && error.name === "ZodError") {
    return "invalid_model_schema";
  }
  if (error instanceof TextModelError && error.code === "timeout") {
    return "model_timeout";
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "model_timeout";
  }
  return "memory_capture_failed";
}

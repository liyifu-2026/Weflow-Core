/**
 * OpenAI 兼容的模型客户端
 * 封装与 OpenAI 兼容 API 的交互，支持：
 * - 文本补全（Chat Completions）
 * - JSON 对象响应格式
 * - 自动重试（首次空响应时）
 */
import { z } from "zod";
import type {
  TextGenerationRequest,
  TextModelMessage,
} from "../../modules/model/contracts/text-generation-request.js";
import type { TextToolDefinition } from "../../modules/model/contracts/text-generation-request.js";
import type { TextGenerationResult } from "../../modules/model/contracts/text-generation-result.js";
import type { TextModel } from "../../modules/model/contracts/text-model.js";
import { TextModelError } from "../../modules/model/contracts/text-model-error.js";

/** 响应 Schema 验证 */
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          // tool_calls 响应的 content 可为 null（DeepSeek 实测）
          content: z.string().nullable().optional(),
          // 思维链（THINKING-PIPELINE-PLAN）：必须显式声明——zod 对象默认
          // 剥离未知字段，此前 reasoning_content 在 parse 时被剥掉，
          // extractReasoning 永远拿到 undefined（model_reasoning 恒为空的真凶）。
          reasoning_content: z.string().nullable().optional(),
          // 原生工具调用请求（FC 协议）
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.string().optional(),
                function: z.object({
                  name: z.string(),
                  arguments: z.string(),
                }),
              }),
            )
            .optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

/** 聊天消息段（Phase 4 视觉直读：与 TextContentPart 同形） */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** 原生工具调用请求（FC 协议，wire 形态） */
export type ChatToolCall = {
  id: string;
  name: string;
  /** JSON 字符串形态的调用参数 */
  arguments: string;
};

/** 聊天消息类型：content 支持 string 或分段数组（图文混合）；FC 支持 tool 角色 */
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  /** role="tool" 时必填：对应的 assistant tool_call id */
  tool_call_id?: string;
  /** role="assistant" 携带原生工具调用请求（其后必须紧跟对应 tool 消息） */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

/** 思维链截断上限：草稿纸不进审计事实，仅展示用。 */
export const REASONING_MAX_CHARS = 8_000;

/**
 * json_object 兜底指令：OpenAI/DeepSeek 等兼容端点要求 prompt 里出现
 * "json" 字样才接受 response_format=json_object，否则 400。业务侧
 * system prompt（如 AI 员工人设）可能整段不含该词，协议层统一兜底；
 * prompt 已含（不区分大小写）则原样透传，不重复注入。
 */
const JSON_OBJECT_HINT = "只输出 JSON。";

function messagePlainText(content: string | ChatContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function withJsonObjectHint(messages: readonly ChatMessage[]): ChatMessage[] {
  const hasJsonWord = messages.some((message) =>
    messagePlainText(message.content).toLowerCase().includes("json"),
  );
  if (hasJsonWord) return [...messages];
  const next = [...messages];
  const systemIndex = next.findIndex((message) => message.role === "system");
  const target = systemIndex === -1 ? undefined : next[systemIndex];
  if (!target) {
    return [{ role: "system", content: JSON_OBJECT_HINT }, ...next];
  }
  next[systemIndex] =
    typeof target.content === "string"
      ? { ...target, content: `${target.content}\n${JSON_OBJECT_HINT}` }
      : {
          ...target,
          content: [
            ...target.content,
            { type: "text", text: JSON_OBJECT_HINT },
          ],
        };
  return next;
}

/**
 * FC 消息归一为 wire 形态：契约扁平的 toolCalls（name/arguments 顶层）
 * 转嵌套 function；tool 消息的 toolCallId 转 tool_call_id。其余透传。
 */
function toWireMessages(messages: readonly TextModelMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool" as const,
        content: message.content,
        tool_call_id: message.toolCallId ?? "",
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant" as const,
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

/**
 * 从 OpenAI 兼容响应里提取推理模型思维链（reasoning_content）。
 * 缺失/空串返回 undefined（不落空事件）；超长截断。
 */
export function extractReasoning(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: { reasoning_content?: unknown } })
    ?.message;
  const raw = message?.reasoning_content;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.slice(0, REASONING_MAX_CHARS);
}

/** 补全选项 */
export type CompletionOptions = {
  jsonObject?: boolean;
  /** 单次调用模型覆盖（运行时切换模型无需重建客户端/重启） */
  model?: string;
  signal?: AbortSignal;
  /** 思考控制；缺省跟随 jsonObject（structured=开，与既有行为一致） */
  thinking?: boolean;
  /** 单次补全预算（含思维链）；缺省用客户端配置 */
  maxTokens?: number;
  /** 单次调用超时；缺省用客户端配置 */
  timeoutMs?: number;
  /** 原生工具定义（FC 协议）；下发后模型以 tool_calls 请求工具 */
  tools?: TextToolDefinition[];
};

type ClientOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 单次补全 token 预算（含思维链）；默认 8_000。来源：MODEL_MAX_TOKENS。 */
  maxTokens?: number;
  fetch?: typeof globalThis.fetch;
};

/** OpenAI 兼容客户端类 */
export class OpenAiCompatibleClient implements TextModel {
  readonly #options: ClientOptions;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  /**
   * 执行文本补全
   * @param messages - 聊天消息数组
   * @param options - 补全选项
   * @returns 模型生成的文本内容
   */
  async complete(
    messages: ChatMessage[],
    options: CompletionOptions = {},
  ): Promise<string> {
    return (await this.completeWithMetadata(messages, options)).text;
  }

  /** Transitional capability adapter; application code should depend on TextModel. */
  async generate(
    request: TextGenerationRequest,
  ): Promise<TextGenerationResult> {
    return this.completeWithMetadata(toWireMessages(request.messages), {
      jsonObject: request.output === "structured",
      ...(request.modelId ? { model: request.modelId } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
      ...(request.maxTokens !== undefined
        ? { maxTokens: request.maxTokens }
        : {}),
      ...(request.timeoutMs !== undefined
        ? { timeoutMs: request.timeoutMs }
        : {}),
      ...(request.tools && request.tools.length > 0
        ? { tools: [...request.tools] }
        : {}),
    });
  }

  private async completeWithMetadata(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {},
  ): Promise<TextGenerationResult> {
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(
        options.timeoutMs ?? this.#options.timeoutMs,
      );
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      const response = await (this.#options.fetch ?? globalThis.fetch)(
        `${this.#options.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: options.model ?? this.#options.model,
            messages: options.jsonObject
              ? withJsonObjectHint(messages)
              : messages,
            stream: false,
            // FC 协议：下发工具定义后模型以 tool_calls 请求工具（受约束解码）
            ...(options.tools && options.tools.length > 0
              ? { tools: options.tools, tool_choice: "auto" }
              : {}),
            // Provider-specific protocol translation stays inside this adapter.
            // 探针证实：DeepSeek API 尊重该字段（enabled/disabled 均生效）。
            // 实测 deepseek-v4-flash-vision-exp 在 disabled+json_object 下会
            // 输出纯空白（finish=stop）；空响应重试（attempt>0）升级为
            // enabled 自愈，正常路径不受影响。
            thinking: {
              type:
                (options.thinking ?? options.jsonObject) || attempt > 0
                  ? "enabled"
                  : "disabled",
            },
            ...(options.jsonObject
              ? { response_format: { type: "json_object" } }
              : {}),
            max_tokens: options.maxTokens ?? this.#options.maxTokens ?? 8_000,
          }),
          signal,
        },
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `model API returned ${String(response.status)}: ${body.slice(0, 500)}`,
        );
      }

      const parsed = responseSchema.parse(await response.json());
      const finishReasonRaw = parsed.choices[0]?.finish_reason ?? null;
      // 截断守卫（决策 #2）：绝不把截断输出当成功返回给解析器。
      // 抛 TextModelError(invalid_response/truncated)——决策层的
      // isRetryableDecisionError 依赖该形态触发"降上下文重试一次"。
      if (finishReasonRaw === "length") {
        throw new TextModelError(
          "invalid_response",
          "model_output_truncated: finish_reason=length (budget exhausted, likely long thinking)",
          { reason: "truncated" },
        );
      }
      const choice = parsed.choices[0];
      // FC 协议：原生工具调用请求——立即返回，不按空响应重试
      const nativeToolCalls: ChatToolCall[] = (choice?.message.tool_calls ?? [])
        .filter((call) => Boolean(call.id) && Boolean(call.function?.name))
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        }));
      const content = choice?.message.content?.trim() ?? "";
      const reasoning = extractReasoning(parsed);
      if (content || nativeToolCalls.length > 0) {
        const finishReason = choice?.finish_reason;
        return {
          text: content,
          ...(nativeToolCalls.length > 0 ? { toolCalls: nativeToolCalls } : {}),
          ...(reasoning ? { reasoning } : {}),
          modelId: parsed.model ?? options.model ?? this.#options.model,
          ...(finishReason
            ? { finishReason: normalizeFinishReason(finishReason) }
            : {}),
          ...(parsed.usage
            ? {
                usage: {
                  ...(parsed.usage.prompt_tokens !== undefined
                    ? { inputTokens: parsed.usage.prompt_tokens }
                    : {}),
                  ...(parsed.usage.completion_tokens !== undefined
                    ? { outputTokens: parsed.usage.completion_tokens }
                    : {}),
                  ...(parsed.usage.total_tokens !== undefined
                    ? { totalTokens: parsed.usage.total_tokens }
                    : {}),
                },
              }
            : {}),
          latencyMs: Date.now() - startedAt,
        };
      }
      if (attempt === 0)
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("model API returned an empty response");
  }
}

function normalizeFinishReason(
  value: string,
): "completed" | "tool_calls" | "length" | "filtered" | "unknown" {
  if (value === "stop") return "completed";
  if (value === "tool_calls") return "tool_calls";
  if (value === "length") return "length";
  if (value === "content_filter") return "filtered";
  return "unknown";
}

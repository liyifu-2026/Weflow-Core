/**
 * OpenAI 兼容的模型客户端
 * 封装与 OpenAI 兼容 API 的交互，支持：
 * - 文本补全（Chat Completions）
 * - JSON 对象响应格式
 * - 自动重试（首次空响应时）
 */
import { z } from "zod";
import type { TextGenerationRequest } from "../../modules/model/contracts/text-generation-request.js";
import type { TextGenerationResult } from "../../modules/model/contracts/text-generation-result.js";
import type { TextModel } from "../../modules/model/contracts/text-model.js";

/** 响应 Schema 验证 */
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
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

/** 聊天消息类型 */
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** 补全选项 */
export type CompletionOptions = {
  jsonObject?: boolean;
  /** 单次调用模型覆盖（运行时切换模型无需重建客户端/重启） */
  model?: string;
  signal?: AbortSignal;
};

type ClientOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
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
    return this.completeWithMetadata(request.messages, {
      jsonObject: request.output === "structured",
      ...(request.modelId ? { model: request.modelId } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  private async completeWithMetadata(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {},
  ): Promise<TextGenerationResult> {
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(this.#options.timeoutMs);
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
            messages,
            stream: false,
            // Provider-specific protocol translation stays inside this adapter.
            thinking: {
              type: options.jsonObject ? "enabled" : "disabled",
            },
            ...(options.jsonObject
              ? { response_format: { type: "json_object" } }
              : {}),
            max_tokens: 8_000,
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
      const content = parsed.choices[0]?.message.content.trim();
      if (content) {
        const finishReason = parsed.choices[0]?.finish_reason;
        return {
          text: content,
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
): "completed" | "length" | "filtered" | "unknown" {
  if (value === "stop") return "completed";
  if (value === "length") return "length";
  if (value === "content_filter") return "filtered";
  return "unknown";
}

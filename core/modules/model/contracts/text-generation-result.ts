import type { TextToolCall } from "./text-generation-request.js";

export type TextGenerationFinishReason =
  "completed" | "tool_calls" | "length" | "filtered" | "unknown";

export type TextGenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type TextGenerationResult = {
  text: string;
  /** 推理模型思维链（reasoning_content）；仅展示用，不进审计事实。 */
  reasoning?: string;
  /**
   * 原生工具调用请求（FC 协议）：非空时 finish_reason=tool_calls，
   * text 侧内容为空/前导语——调用方应执行工具并回喂，而非当作最终决策。
   */
  toolCalls?: TextToolCall[];
  /** Effective provider model identifier, for observability only. */
  modelId: string;
  finishReason?: TextGenerationFinishReason;
  usage?: TextGenerationUsage;
  latencyMs?: number;
};

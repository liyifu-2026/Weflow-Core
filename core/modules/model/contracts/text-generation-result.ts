export type TextGenerationFinishReason =
  "completed" | "length" | "filtered" | "unknown";

export type TextGenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type TextGenerationResult = {
  text: string;
  /** 推理模型思维链（reasoning_content）；仅展示用，不进审计事实。 */
  reasoning?: string;
  /** Effective provider model identifier, for observability only. */
  modelId: string;
  finishReason?: TextGenerationFinishReason;
  usage?: TextGenerationUsage;
  latencyMs?: number;
};

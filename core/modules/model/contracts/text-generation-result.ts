export type TextGenerationFinishReason =
  "completed" | "length" | "filtered" | "unknown";

export type TextGenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type TextGenerationResult = {
  text: string;
  /** Effective provider model identifier, for observability only. */
  modelId: string;
  finishReason?: TextGenerationFinishReason;
  usage?: TextGenerationUsage;
  latencyMs?: number;
};

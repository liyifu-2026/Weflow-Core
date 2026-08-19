export type TextModelRole = "system" | "user" | "assistant";

export type TextModelMessage = {
  role: TextModelRole;
  content: string;
};

export type TextGenerationRequest = {
  messages: readonly TextModelMessage[];
  /** Optional runtime model override. Providers choose their configured default when omitted. */
  modelId?: string;
  /** Structured mode guarantees JSON text; schema validation remains an application concern. */
  output?: "text" | "structured";
  signal?: AbortSignal;
  purpose?: string;
  traceId?: string;
};

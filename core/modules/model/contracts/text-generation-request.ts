export type TextModelRole = "system" | "user" | "assistant";

/**
 * 多模态消息段（Phase 4 视觉直读）：string 用法全兼容既有调用点；
 * 图片以 ContentPart 数组表达，provider 侧按需拼 image_url。
 */
export type TextContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type TextModelContent = string | TextContentPart[];

export type TextModelMessage = {
  role: TextModelRole;
  content: TextModelContent;
};

/** 判断 content 是否为多模态数组。 */
export function isMultimodalContent(
  content: TextModelContent,
): content is TextContentPart[] {
  return Array.isArray(content);
}

/** 提取 content 中的纯文本（数组时拼接全部 text 段，忽略图片段）。 */
export function textOfContent(content: TextModelContent): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

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

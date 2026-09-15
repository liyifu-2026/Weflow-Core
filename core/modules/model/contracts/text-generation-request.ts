export type TextModelRole = "system" | "user" | "assistant" | "tool";

/**
 * 多模态消息段（Phase 4 视觉直读）：string 用法全兼容既有调用点；
 * 图片以 ContentPart 数组表达，provider 侧按需拼 image_url。
 */
export type TextContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type TextModelContent = string | TextContentPart[];

/**
 * 原生工具调用请求（FC 协议）：模型以 tool_calls 请求工具时的一条请求。
 * arguments 保持 wire 原始形态（JSON 字符串），解析归应用层。
 */
export type TextToolCall = {
  id: string;
  name: string;
  arguments: string;
  /** wire 规范标记；固定 "function" */
  type?: string;
};

/**
 * 原生工具定义（OpenAI 兼容格式）：name/description/parameters。
 * 由 tool-catalog 按 availableTools 派生，平台不下发目录之外的条目。
 */
export type TextToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type TextModelMessage = {
  role: TextModelRole;
  content: TextModelContent;
  /** role="tool" 时必填：本条结果对应的 assistant tool_call id。 */
  toolCallId?: string;
  /** role="assistant" 携带原生工具调用请求（FC 协议；其后必须紧跟对应 tool 消息）。 */
  toolCalls?: TextToolCall[];
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
  /**
   * 思考控制（THINKING-PIPELINE-PLAN B1）。缺省跟随调用形态：
   * structured（JSON 决策）= 开、text = 关（与既有行为逐字节一致）。
   * 探针（docs/model-probe-result.json）证实 DeepSeek API 尊重该字段。
   */
  thinking?: boolean;
  /** 单次补全 token 预算（含思维链）。缺省用客户端配置（MODEL_MAX_TOKENS）。 */
  maxTokens?: number;
  /** 单次调用超时（毫秒）。缺省用客户端配置。 */
  timeoutMs?: number;
  /**
   * 原生工具定义（FC 协议）：下发后模型以 tool_calls 请求工具（受约束
   * 解码），工具结果以 role="tool" 消息回喂。仅下发 availableTools 内条目。
   */
  tools?: readonly TextToolDefinition[];
};

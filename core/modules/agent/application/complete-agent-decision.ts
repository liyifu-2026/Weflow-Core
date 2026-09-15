/**
 * Agent 决策模型调用模块
 *
 * 调用 LLM 获取 Agent 决策结果。
 * 当模型返回空响应时，自动截取最近 4 条消息重试。
 */

import type { TextModelMessage } from "../../model/contracts/text-generation-request.js";
import { isMultimodalContent } from "../../model/contracts/text-generation-request.js";
import type {
  TextToolCall,
  TextToolDefinition,
} from "../../model/contracts/text-generation-request.js";
import { TextModelError } from "../../model/contracts/text-model-error.js";
import type { TextModel } from "../../model/contracts/text-model.js";

/** 决策模型调用结果：text 为决策 JSON；reasoning 为思维链（可缺省）。 */
export type AgentDecisionResponse = {
  text: string;
  reasoning?: string | undefined;
  finishReason?: string | undefined;
  latencyMs?: number | undefined;
  usage?:
    | {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        totalTokens?: number | undefined;
      }
    | undefined;
  /** 非空 = 模型以原生 tool_calls 请求工具（FC 协议）；调用方执行后回喂。 */
  toolCalls?: TextToolCall[] | undefined;
};

/**
 * 调用 LLM 完成 Agent 决策
 * 要求返回 JSON 对象格式的响应（FC 下发工具时，模型也可能以 tool_calls 请求工具）
 * @param model - 可选运行时模型覆盖（来自 runtime_settings，切换无需重启）
 */
export async function completeAgentDecision(
  textModel: TextModel,
  messages: TextModelMessage[],
  runtimeModel?: string,
  options?: {
    timeoutMs?: number | undefined;
    /** 原生工具定义（FC 协议）；透传给模型请求。 */
    tools?: readonly TextToolDefinition[];
  },
): Promise<AgentDecisionResponse> {
  try {
    return await generateDecision(textModel, messages, runtimeModel, options);
  } catch (error) {
    // 空响应或截断（预算耗尽）时截取系统提示 + 最近 4 条消息重试一次；
    // 再失败则向上抛出（truncated 由失败协调器转人工，决策 #2）。
    if (!isRetryableDecisionError(error)) throw error;
    const fallbackMessages = repairToolMessagePairs(
      [messages[0], ...messages.slice(-4)].filter(
        (message): message is TextModelMessage => Boolean(message),
      ),
    );
    return await generateDecision(
      textModel,
      fallbackMessages,
      runtimeModel,
      options,
    );
  }
}

/**
 * 降上下文重试时保证 FC 消息对完整：assistant(toolCalls) 与其 tool 结果
 * 必须成对出现，孤儿 tool 消息会被 API 拒绝（400）。v1 结构中该对位于
 * 消息尾部（slice(-4) 必然整体保留），此处仅做防御性清理。
 */
function repairToolMessagePairs(
  messages: TextModelMessage[],
): TextModelMessage[] {
  return messages.filter((message, index) => {
    if (message.role !== "tool") return true;
    const previous = messages[index - 1];
    return Boolean(
      previous &&
      previous.role === "assistant" &&
      previous.toolCalls?.some(
        (call) => call.id === (message as { toolCallId?: string }).toolCallId,
      ),
    );
  });
}

async function generateDecision(
  textModel: TextModel,
  messages: TextModelMessage[],
  runtimeModel: string | undefined,
  options?: {
    timeoutMs?: number | undefined;
    tools?: readonly TextToolDefinition[];
  },
): Promise<AgentDecisionResponse> {
  // 决策默认关思考（结构化选择任务不需长推理，见既有注释）；但当本轮
  // 携带图片（视觉直读）时回升 thinking——视觉模型在
  // thinking=disabled + json_object 下实测输出纯空白，思考开启后才稳定。
  const hasImage = messages.some(
    (message) =>
      isMultimodalContent(message.content) &&
      message.content.some((part) => part.type === "image_url"),
  );
  const result = await textModel.generate({
    messages,
    ...(runtimeModel ? { modelId: runtimeModel } : {}),
    output: "structured",
    thinking: hasImage,
    ...(options?.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options?.tools && options.tools.length > 0
      ? { tools: options.tools }
      : {}),
  });
  return {
    text: result.text,
    reasoning: result.reasoning,
    finishReason: result.finishReason,
    latencyMs: result.latencyMs,
    usage: result.usage,
    toolCalls: result.toolCalls,
  };
}

/** 判断是否可降上下文重试的决策错误：空响应或输出截断 */
function isRetryableDecisionError(error: unknown): boolean {
  const isEmpty =
    (error instanceof TextModelError &&
      error.code === "invalid_response" &&
      error.options.reason === "empty_response") ||
    (error instanceof Error &&
      error.message === "model API returned an empty response");
  const isTruncated =
    error instanceof TextModelError &&
    error.code === "invalid_response" &&
    error.options.reason === "truncated";
  return isEmpty || isTruncated;
}

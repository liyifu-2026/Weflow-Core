/**
 * Agent 决策模型调用模块
 *
 * 调用 LLM 获取 Agent 决策结果。
 * 当模型返回空响应时，自动截取最近 4 条消息重试。
 */

import type { TextModelMessage } from "../../model/contracts/text-generation-request.js";
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
};

/**
 * 调用 LLM 完成 Agent 决策
 * 要求返回 JSON 对象格式的响应
 * @param model - 可选运行时模型覆盖（来自 runtime_settings，切换无需重启）
 */
export async function completeAgentDecision(
  textModel: TextModel,
  messages: TextModelMessage[],
  runtimeModel?: string,
  options?: { timeoutMs?: number | undefined },
): Promise<AgentDecisionResponse> {
  try {
    return await generateDecision(textModel, messages, runtimeModel, options);
  } catch (error) {
    // 空响应或截断（预算耗尽）时截取系统提示 + 最近 4 条消息重试一次；
    // 再失败则向上抛出（truncated 由失败协调器转人工，决策 #2）。
    if (!isRetryableDecisionError(error)) throw error;
    const fallbackMessages = [messages[0], ...messages.slice(-4)].filter(
      (message): message is TextModelMessage => Boolean(message),
    );
    return await generateDecision(textModel, fallbackMessages, runtimeModel, options);
  }
}

async function generateDecision(
  textModel: TextModel,
  messages: TextModelMessage[],
  runtimeModel: string | undefined,
  options?: { timeoutMs?: number | undefined },
): Promise<AgentDecisionResponse> {
  const result = await textModel.generate({
    messages,
    ...(runtimeModel ? { modelId: runtimeModel } : {}),
    output: "structured",
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return {
    text: result.text,
    reasoning: result.reasoning,
    finishReason: result.finishReason,
    latencyMs: result.latencyMs,
    usage: result.usage,
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

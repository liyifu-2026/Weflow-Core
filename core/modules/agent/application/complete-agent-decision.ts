/**
 * Agent 决策模型调用模块
 *
 * 调用 LLM 获取 Agent 决策结果。
 * 当模型返回空响应时，自动截取最近 4 条消息重试。
 */

import type { TextModelMessage } from "../../model/contracts/text-generation-request.js";
import { TextModelError } from "../../model/contracts/text-model-error.js";
import type { TextModel } from "../../model/contracts/text-model.js";

/**
 * 调用 LLM 完成 Agent 决策
 * 要求返回 JSON 对象格式的响应
 * @param model - 可选运行时模型覆盖（来自 runtime_settings，切换无需重启）
 */
export async function completeAgentDecision(
  textModel: TextModel,
  messages: TextModelMessage[],
  runtimeModel?: string,
): Promise<string> {
  try {
    const result = await textModel.generate({
      messages,
      ...(runtimeModel ? { modelId: runtimeModel } : {}),
      output: "structured",
    });
    return result.text;
  } catch (error) {
    // 空响应时截取系统提示 + 最近 4 条消息重试（减少上下文长度）
    if (!isEmptyResponse(error)) throw error;
    const fallbackMessages = [messages[0], ...messages.slice(-4)].filter(
      (message): message is TextModelMessage => Boolean(message),
    );
    const result = await textModel.generate({
      messages: fallbackMessages,
      ...(runtimeModel ? { modelId: runtimeModel } : {}),
      output: "structured",
    });
    return result.text;
  }
}

/** 判断是否为模型空响应错误 */
function isEmptyResponse(error: unknown): boolean {
  return (
    (error instanceof TextModelError &&
      error.code === "invalid_response" &&
      error.options.reason === "empty_response") ||
    (error instanceof Error &&
      error.message === "model API returned an empty response")
  );
}

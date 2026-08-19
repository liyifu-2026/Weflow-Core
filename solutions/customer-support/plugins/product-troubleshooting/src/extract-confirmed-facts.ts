/**
 * 从会话历史中提取已确认(或待确认)的客户事实
 *
 * - 仍使用确定性正则识别客户明确陈述的软件版本号与错误代码
 * - 通过小型封闭的 epistemic 标记集合识别明显的不确定表达(好像/应该/可能等),
 *   命中时事实进入 uncertain,绝不自动 confirmed
 * - 更复杂的语义不确定性由 Planner 在 facts_to_store 中声明,不依赖词库扩充
 */

import { inferGranularity, type CaseFactUpdate } from "./case-facts.js";

/** 明显不确定表达的封闭标记集(刻意保持小,不做 NLP 扩充) */
const EPISTEMIC_HEDGES =
  /好像|应该是|可能是|可能是|大概|估计|不确定|也许|疑似|大约|应该(?:是|有)?/;

type HistoryMessage = { role: "user" | "assistant"; content: string };

export function extractConfirmedFacts(
  history: HistoryMessage[],
): CaseFactUpdate[] {
  const facts: CaseFactUpdate[] = [];
  for (const message of history.filter((item) => item.role === "user")) {
    const status = EPISTEMIC_HEDGES.test(message.content)
      ? "uncertain"
      : "confirmed";
    // 提取软件版本号(如 V1.2.3)
    const version = message.content.match(/\bV\d+(?:\.\d+){0,3}\b/i)?.[0];
    if (version) {
      const value = version.toUpperCase();
      const granularity = inferGranularity(value);
      facts.push({
        field: "software_version",
        value,
        status,
        source: "customer",
        ...(granularity ? { granularity } : {}),
      });
    }
    // 提取错误代码(如 错误码: 404 或 error code: E001)
    const errorCode = message.content.match(
      /(?:错误(?:代码|码)|error\s*code)\s*[:：]?\s*([A-Za-z]?\d{3,})/i,
    )?.[1];
    if (errorCode) {
      facts.push({
        field: "error_code",
        value: errorCode,
        status,
        source: "customer",
      });
    }
  }
  return facts;
}

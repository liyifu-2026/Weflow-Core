/**
 * Triage 预判分流器（平台中立机制）。
 *
 * 在 Agent Turn 进入主决策前做一次廉价判定：
 * - 规则先行：触发文本命中注入的风险关键词 → 直接转人工（0 成本 0 延迟）；
 * - LLM 分类：极速小模型输出 JSON {route, tier, reason}，供分流与审计；
 * - 兜底原则：任何失败/超时/解析异常一律 fail-open 回到主决策路径，
 *   绝不因分流层故障阻断消息处理。
 *
 * 业务策略（风险关键词清单、直答开关等）由组合根从 Solution 扩展设置
 * 读取后经 TriagePolicy 注入；本模块不含任何业务关键词。
 */

import type { TextModel } from "../../model/contracts/text-model.js";
import { completeAgentDecision } from "./complete-agent-decision.js";

export type TriagePolicy = {
  /** 总开关：false 时整层短路放行（零行为变化） */
  enabled: boolean;
  /** 高危关键词：命中即转人工（大小写不敏感子串匹配） */
  riskKeywords: string[];
  /**
   * LLM 二级分类的 system prompt（ADR-0011 业务缺省出引擎）：原为引擎
   * 硬编码的客服预判话术，现由扩展设置 pipeline.triage.systemPrompt 下发。
   * 空 = LLM 层不可用（fail-open 放行），引擎不再自备任何业务话术。
   */
  systemPrompt: string;
  /** 是否使用 LLM 做二级分类（false 时仅规则层生效） */
  llmClassifyEnabled: boolean;
  /** LLM 判定超时（毫秒），超时视为分类不可用 */
  timeoutMs: number;
  /** simple 档是否允许直答模型生成客户回复 */
  allowDirectReply: boolean;
};

/** 默认策略：全关。未配置时链路与改造前逐字节一致。 */
export const DEFAULT_TRIAGE_POLICY: TriagePolicy = {
  enabled: false,
  riskKeywords: [],
  systemPrompt: "",
  llmClassifyEnabled: true,
  timeoutMs: 3_000,
  allowDirectReply: false,
};

export type TriageVerdict = {
  route: "human" | "auto";
  tier: "simple" | "standard";
  reason: string;
  degraded: boolean;
};

/** 分流不可用/关闭时的统一放行判定 */
export const TRIAGE_PASS_THROUGH_VERDICT: TriageVerdict = {
  route: "auto",
  tier: "standard",
  reason: "triage_pass_through",
  degraded: false,
};

/**
 * 从 Solution 扩展设置的原始 JSON 容错提取 TriagePolicy。
 * 期望形状：{ pipeline: { triage: { enabled, riskKeywords, ... } } }
 * 缺失/类型不符的字段逐项回落默认值。
 */
export function extractTriagePolicy(raw: unknown): TriagePolicy {
  if (typeof raw !== "object" || raw === null) return DEFAULT_TRIAGE_POLICY;
  const pipeline = (raw as Record<string, unknown>).pipeline;
  if (typeof pipeline !== "object" || pipeline === null) {
    return DEFAULT_TRIAGE_POLICY;
  }
  const triage = (pipeline as Record<string, unknown>).triage;
  if (typeof triage !== "object" || triage === null) {
    return DEFAULT_TRIAGE_POLICY;
  }
  const t = triage as Record<string, unknown>;
  return {
    enabled: typeof t.enabled === "boolean" ? t.enabled : DEFAULT_TRIAGE_POLICY.enabled,
    riskKeywords: Array.isArray(t.riskKeywords)
      ? t.riskKeywords.filter(
          (keyword): keyword is string =>
            typeof keyword === "string" && keyword.trim() !== "",
        )
      : [],
    systemPrompt:
      typeof t.systemPrompt === "string" && t.systemPrompt.trim() !== ""
        ? t.systemPrompt.trim()
        : DEFAULT_TRIAGE_POLICY.systemPrompt,
    llmClassifyEnabled:
      typeof t.llmClassifyEnabled === "boolean"
        ? t.llmClassifyEnabled
        : DEFAULT_TRIAGE_POLICY.llmClassifyEnabled,
    timeoutMs:
      typeof t.timeoutMs === "number" &&
      Number.isFinite(t.timeoutMs) &&
      t.timeoutMs >= 500 &&
      t.timeoutMs <= 15_000
        ? Math.round(t.timeoutMs)
        : DEFAULT_TRIAGE_POLICY.timeoutMs,
    allowDirectReply:
      typeof t.allowDirectReply === "boolean"
        ? t.allowDirectReply
        : DEFAULT_TRIAGE_POLICY.allowDirectReply,
  };
}

const TRIAGE_OUTPUT_CONTRACT =
  '只输出一个 JSON 对象：{"route":"auto"|"human","tier":"simple"|"standard","reason":"不超过20字"} 。除该 JSON 外不要输出任何其他内容。';

/** 单次预判分类入口。永不抛错：内部兜底降级为放行判定。 */
export async function classifyForTriage(input: {
  policy: TriagePolicy;
  client?: TextModel | undefined;
  model?: string | undefined;
  triggerText: string;
  recentInboundTexts?: readonly string[] | undefined;
}): Promise<TriageVerdict> {
  const { policy } = input;
  if (!policy.enabled) return TRIAGE_PASS_THROUGH_VERDICT;

  // 规则先行：风险关键词命中直接转人工，不花 LLM 成本。
  const normalizedTrigger = input.triggerText.toLowerCase();
  const hitKeyword = policy.riskKeywords.find((keyword) => {
    const needle = keyword.toLowerCase();
    return needle !== "" && normalizedTrigger.includes(needle);
  });
  if (hitKeyword) {
    return {
      route: "human",
      tier: "standard",
      reason: `risk_keyword_hit:${hitKeyword}`,
      degraded: false,
    };
  }

  if (
    !policy.llmClassifyEnabled ||
    !input.client ||
    !input.model ||
    policy.systemPrompt === ""
  ) {
    return {
      route: "auto",
      tier: "standard",
      reason: policy.systemPrompt === ""
        ? "triage_prompt_unconfigured"
        : "llm_classify_unavailable",
      degraded: false,
    };
  }

  try {
    const contextLines = (input.recentInboundTexts ?? [])
      .slice(-3)
      .map((text) => `- ${text.slice(0, 120)}`);
    const response = await withTimeout(
      completeAgentDecision(input.client, [
        {
          role: "system",
          // 业务判定规则由设置下发（ADR-0011）；JSON 输出契约是解析器的
          // 机制前提，由引擎追加——业务话术与机制格式在此拼合。
          content: `${policy.systemPrompt}\n${TRIAGE_OUTPUT_CONTRACT}`,
        },
        {
          role: "user",
          content: [
            `最新客户消息：${input.triggerText.slice(0, 300)}`,
            ...(contextLines.length > 0
              ? ["近期上下文（由旧到新）：", ...contextLines]
              : []),
          ].join("\n"),
        },
      ], input.model),
      policy.timeoutMs,
    );
    const parsed = parseTriageResponse(response.text);
    if (parsed) return parsed;
  } catch {
    // fall through to degraded pass-through
  }
  return {
    route: "auto",
    tier: "standard",
    reason: "triage_llm_failed_or_timeout",
    degraded: true,
  };
}

function parseTriageResponse(text: string): TriageVerdict | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (value.route !== "human" && value.route !== "auto") return undefined;
    const tier =
      value.tier === "simple" ? ("simple" as const) : ("standard" as const);
    const reason =
      typeof value.reason === "string" && value.reason.trim() !== ""
        ? value.reason.trim().slice(0, 60)
        : "classified";
    return {
      route: value.route,
      tier,
      reason,
      degraded: false,
    };
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`triage_timeout:${String(timeoutMs)}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

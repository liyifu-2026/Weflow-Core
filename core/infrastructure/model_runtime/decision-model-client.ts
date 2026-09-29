/**
 * System One 结构化决策模型客户端（decision-model-preview）。
 *
 * 百炼决策模型一次前向返回结构化判定（choice/noul/score + 全概率分布 +
 * 置信度），不生成文本，延迟与输出长度无关（文档示例 52.9ms/1 问）。本
 * 客户端是业务中立的薄封装：POST {baseUrl}/compatible-mode/v1/systemone，
 * Bearer 鉴权，zod 收敛响应；任何网络/解析失败都折叠为 {ok:false}，
 * 绝不抛错——调用方（decision-triage 缝）据此 fail-open。
 *
 * 协议要点（2026-09-30 官方文档实查）：
 * - 请求：{ model, state: string|object|array（≤65,536 token）, questions }；
 *   questions 每项 { type: "choice"|"noul"|"score", instructions?, criteria? }，
 *   延迟随问题数近线性增长 → 延迟敏感路径的调用方自行控制在 ≤3 问。
 * - 响应：{ answers: { <qid>: { answer, probabilities?, confidence?, legend? } },
 *   usage: { input_tokens }, model, latency_ms? }。model 字段实测落审计，
 *   不在逻辑里硬编码快照名（preview 模型生命周期风险对冲）。
 */
import { z } from "zod";

/** 端点连接参数（组合根从 decision 槽位解析；apiKey 属 secret 不落审计） */
export type DecisionModelEndpoint = {
  baseUrl: string;
  apiKey: string;
  /** 请求体 model 字段；缺省时端点默认模型生效 */
  model?: string | undefined;
  /** 整调用超时（毫秒）。判定在客户等待路径上，出厂 500ms 硬顶。 */
  timeoutMs: number;
};

/** 决策问题定义（业务语义原文透传，引擎不解释其内容） */
export type DecisionQuestionDef = {
  type: "choice" | "noul" | "score";
  instructions?: string | undefined;
  /** choice 选项表 / score 等级说明（原文透传） */
  criteria?: Record<string, unknown> | undefined;
};

/** 单个问题的判定回包（宽松收敛：真实协议字段 + 原始 answer 兜底） */
export type DecisionAnswer = {
  /**
   * 归一化判定值：noul = P(yes)；choice = 命中选项键；score = 加权期望。
   * 真实协议（2026-09-30 实测）值分别在 noul/choice 字段，这里统一提取；
   * 完全陌生的形态则保留整个原始对象。
   */
  answer: unknown;
  /** noul 判定的原始概率字段（answer 的来源之一，保留便于审计） */
  noul?: number | undefined;
  /** choice 判定的原始选项字段 */
  choice?: unknown;
  probabilities?: Record<string, number> | undefined;
  confidence?: number | undefined;
  legend?: unknown;
};

export type DecisionCallSuccess = {
  ok: true;
  answers: Record<string, DecisionAnswer>;
  inputTokens: number | null;
  latencyMs: number | null;
  /** 端点返回的实测模型名（落审计；快照漂移可观测） */
  model: string | null;
};

export type DecisionCallFailure = {
  ok: false;
  /** 稳定错误码：timeout / http_<status> / network / bad_response */
  errorCode: string;
};

export type DecisionCallResult = DecisionCallSuccess | DecisionCallFailure;

const responseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({ input_tokens: z.number().finite().optional() })
    .partial()
    .optional(),
  model: z.string().optional(),
  latency_ms: z.number().finite().optional(),
});

/**
 * 调用一次结构化决策。永不抛错；所有失败折叠为 {ok:false, errorCode}。
 * fetch 可注入（测试）；默认 global fetch。超时经 AbortController 硬顶。
 */
export async function callDecisionModel(
  endpoint: DecisionModelEndpoint,
  input: {
    state: string | object | unknown[];
    questions: Record<string, DecisionQuestionDef>;
    fetchImpl?: typeof fetch | undefined;
  },
): Promise<DecisionCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);
  try {
    const response = await (input.fetchImpl ?? fetch)(
      `${endpoint.baseUrl.replace(/\/+$/, "")}/compatible-mode/v1/systemone`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${endpoint.apiKey}`,
        },
        body: JSON.stringify({
          model: endpoint.model ?? "decision-model-preview",
          state: input.state,
          questions: input.questions,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return { ok: false, errorCode: `http_${response.status}` };
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, errorCode: "bad_response" };
    }
    const answers: Record<string, DecisionAnswer> = {};
    for (const [key, value] of Object.entries(parsed.data.answers)) {
      const shape = questionAnswerSchema.safeParse(value);
      if (!shape.success) {
        answers[key] = { answer: value };
        continue;
      }
      const shaped = shape.data;
      // 真实协议：noul 值在 `noul` 字段、choice 在 `choice` 字段（2026-09-30
      // 实测）；answer 字段是文档示例形态。都缺时保留原始对象不丢信息。
      const answer =
        shaped.answer !== undefined
          ? shaped.answer
          : shaped.noul !== undefined
            ? shaped.noul
            : shaped.choice !== undefined
              ? shaped.choice
              : value;
      answers[key] = {
        answer,
        ...(shaped.noul !== undefined ? { noul: shaped.noul } : {}),
        ...(shaped.choice !== undefined ? { choice: shaped.choice } : {}),
        ...(shaped.probabilities !== undefined
          ? { probabilities: shaped.probabilities }
          : {}),
        ...(shaped.confidence !== undefined
          ? { confidence: shaped.confidence }
          : {}),
        ...(shaped.legend !== undefined ? { legend: shaped.legend } : {}),
      };
    }
    return {
      ok: true,
      answers,
      inputTokens: parsed.data.usage?.input_tokens ?? null,
      latencyMs: parsed.data.latency_ms ?? null,
      model: parsed.data.model ?? null,
    };
  } catch (error) {
    const aborted =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    return {
      ok: false,
      errorCode: aborted
        ? "timeout"
        : error instanceof Error &&
            error.message.startsWith("fetch failed")
          ? "network"
          : `network:${(error as Error)?.name ?? "unknown"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const questionAnswerSchema = z
  .object({
    answer: z.unknown(),
    /** 真实协议（2026-09-30 实测）：noul 值在此字段 */
    noul: z.number().finite().optional(),
    /** 真实协议：choice 命中选项键在此字段 */
    choice: z.unknown(),
    probabilities: z.record(z.string(), z.number().finite()).optional(),
    confidence: z.number().finite().optional(),
    legend: z.unknown().optional(),
  })
  .partial();

/** 从 noul 判定回包读 P(yes)：answer 数 → noul 字段 → 不可得 undefined。 */
export function readNoulProbability(
  answer: DecisionAnswer | undefined,
): number | undefined {
  if (!answer) return undefined;
  if (typeof answer.answer === "number" && Number.isFinite(answer.answer)) {
    return answer.answer;
  }
  if (typeof answer.noul === "number" && Number.isFinite(answer.noul)) {
    return answer.noul;
  }
  return undefined;
}

/** 从 choice 判定回包读指定选项的概率：probabilities 表，缺表时命中即 1。 */
export function readChoiceProbability(
  answer: DecisionAnswer | undefined,
  option: string,
): number | undefined {
  const fromTable = answer?.probabilities?.[option];
  if (fromTable !== undefined) return fromTable;
  return answer?.choice === option || answer?.answer === option ? 1 : undefined;
}

/** choice/score 的置信度（noul 文档未承诺，可能缺省）。 */
export function readDecisionConfidence(
  answer: DecisionAnswer | undefined,
): number | undefined {
  return answer?.confidence;
}

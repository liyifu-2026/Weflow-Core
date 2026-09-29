/**
 * 决策模型缝（decision-model-preview / System One）：把结构化判定接进
 * Agent Turn 的 triage 缝（评审方案 96.5/100，2026-09-30）。
 *
 * 落点与语义（全部默认关闭，关闭 = 行为与接入前逐字节一致）：
 * - shadowEnabled：旁路影子调用，只落 decision_model_shadow 审计事件，
 *   不消费结果——校准期零行为变化；
 * - triageEnabled：替换 triage 的 LLM 分类档（P(need_human) 阈值 → 转人工，
 *   P(simple) → 直答档）；失败回退现有 LLM 档再放行主决策；
 * - worthReplyEnabled：P(值得回复) 极低 → 跳过主决策、轮次以 no_action
 *   快速终结；fail-open 落点是主决策本身。
 *
 * 宪法边界（ADR-0011 家法）：问题集全文与阈值是业务语义，经扩展设置
 * decision 键下发（组合根注入）；本模块只做机制——拼装、调用、阈值比较，
 * 不含任何业务关键词。缝存在性 = triageEnabled OR worthReplyEnabled
 * （OR shadowEnabled），不与 triage 槽位绑定耦合。
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import {
  callDecisionModel,
  readChoiceProbability,
  readDecisionConfidence,
  readNoulProbability,
  type DecisionCallSuccess,
  type DecisionModelEndpoint,
  type DecisionQuestionDef,
} from "../../../infrastructure/model_runtime/decision-model-client.js";

/** 稳定问题 ID（审计与回包解析的唯一键，业务设置必须用同名键） */
export const DECISION_QUESTION_IDS = {
  needHuman: "q_need_human",
  tier: "q_tier",
  worthReply: "q_worth_reply",
  /** Phase 3：handoff 待认领队列紧急度（score，criteria 数组档数即分值上限） */
  urgency: "q_urgency",
  /** Phase 3：记忆提取前价值预判（noul） */
  hasMemory: "q_has_memory",
  /** Phase 4：短静默窗收窗判定——客户想说的话说完整了吗（noul） */
  finished: "q_finished",
} as const;

/** 扩展设置 decision 键的收敛形态（缺省全关） */
export type DecisionSettings = {
  /** 影子模式：调用并落审计，不消费结果 */
  shadowEnabled: boolean;
  /**
   * Phase 4 短静默窗：开启后 ingest 按 quietWindowMs 登记基准窗（正则
   * 不再延长），收窗时由决策模型判「说完了吗」，未说完才续窗。
   */
  halfSentenceEnabled: boolean;
  /** Phase 4 基准静默窗毫秒（halfSentenceEnabled 时生效；出厂 12s，可调短） */
  quietWindowMs: number;
  /** 主动模式：决策模型结果替换 triage LLM 分类档 */
  triageEnabled: boolean;
  /** 主动模式：P(不值得回复)≥noReplyProbability → 轮次 no_action 终结 */
  worthReplyEnabled: boolean;
  timeoutMs: number;
  thresholds: {
    humanProbability: number;
    humanConfidence: number;
    simpleProbability: number;
    noReplyProbability: number;
  };
  questions: Partial<Record<string, DecisionQuestionDef>>;
};

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  shadowEnabled: false,
  halfSentenceEnabled: false,
  quietWindowMs: 12_000,
  triageEnabled: false,
  worthReplyEnabled: false,
  timeoutMs: 500,
  thresholds: {
    humanProbability: 0.85,
    humanConfidence: 0.6,
    simpleProbability: 0.8,
    noReplyProbability: 0.9,
  },
  questions: {},
};

const clampUnit = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;

/** 从扩展设置原始 JSON 容容提取 decision 键；形状逐项回落默认（全关）。 */
export function extractDecisionSettings(raw: unknown): DecisionSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_DECISION_SETTINGS;
  const d = (raw as Record<string, unknown>).decision;
  if (typeof d !== "object" || d === null) return DEFAULT_DECISION_SETTINGS;
  const s = d as Record<string, unknown>;
  const thresholds =
    typeof s.thresholds === "object" && s.thresholds !== null
      ? (s.thresholds as Record<string, unknown>)
      : {};
  const questions: Partial<Record<string, DecisionQuestionDef>> = {};
  if (typeof s.questions === "object" && s.questions !== null) {
    for (const [key, value] of Object.entries(
      s.questions as Record<string, unknown>,
    )) {
      if (typeof value !== "object" || value === null) continue;
      const q = value as Record<string, unknown>;
      if (
        q.type !== "choice" &&
        q.type !== "noul" &&
        q.type !== "score"
      ) {
        continue;
      }
      questions[key] = {
        type: q.type,
        ...(typeof q.instructions === "string" && q.instructions.trim() !== ""
          ? { instructions: q.instructions }
          : {}),
        ...(typeof q.criteria === "object" && q.criteria !== null
          ? { criteria: q.criteria as Record<string, unknown> | unknown[] }
          : {}),
      };
    }
  }
  return {
    shadowEnabled: s.shadowEnabled === true,
    halfSentenceEnabled: s.halfSentenceEnabled === true,
    quietWindowMs:
      typeof s.quietWindowMs === "number" &&
      Number.isFinite(s.quietWindowMs) &&
      s.quietWindowMs >= 3_000 &&
      s.quietWindowMs <= 30_000
        ? Math.round(s.quietWindowMs)
        : DEFAULT_DECISION_SETTINGS.quietWindowMs,
    triageEnabled: s.triageEnabled === true,
    worthReplyEnabled: s.worthReplyEnabled === true,
    timeoutMs:
      typeof s.timeoutMs === "number" &&
      Number.isFinite(s.timeoutMs) &&
      s.timeoutMs >= 200 &&
      s.timeoutMs <= 5_000
        ? Math.round(s.timeoutMs)
        : DEFAULT_DECISION_SETTINGS.timeoutMs,
    thresholds: {
      humanProbability: clampUnit(
        thresholds.humanProbability,
        DEFAULT_DECISION_SETTINGS.thresholds.humanProbability,
      ),
      humanConfidence: clampUnit(
        thresholds.humanConfidence,
        DEFAULT_DECISION_SETTINGS.thresholds.humanConfidence,
      ),
      simpleProbability: clampUnit(
        thresholds.simpleProbability,
        DEFAULT_DECISION_SETTINGS.thresholds.simpleProbability,
      ),
      noReplyProbability: clampUnit(
        thresholds.noReplyProbability,
        DEFAULT_DECISION_SETTINGS.thresholds.noReplyProbability,
      ),
    },
    questions,
  };
}

/** 三个功能开关是否至少一个打开（决定缝/影子是否存在） */
export function isDecisionSeamActive(settings: DecisionSettings): boolean {
  return (
    settings.shadowEnabled ||
    settings.triageEnabled ||
    settings.worthReplyEnabled
  );
}

/** 按开关拼装本次调用的问题集：主动问题按需、影子问题全量。 */
export function buildDecisionQuestions(
  settings: DecisionSettings,
): Record<string, DecisionQuestionDef> {
  const questions: Record<string, DecisionQuestionDef> = {};
  const pick = (id: string): DecisionQuestionDef | undefined =>
    settings.questions[id];
  if (settings.triageEnabled || settings.shadowEnabled) {
    const needHuman = pick(DECISION_QUESTION_IDS.needHuman);
    if (needHuman) {
      questions[DECISION_QUESTION_IDS.needHuman] = needHuman;
    }
    const tier = pick(DECISION_QUESTION_IDS.tier);
    if (tier) {
      questions[DECISION_QUESTION_IDS.tier] = tier;
    }
  }
  if (settings.worthReplyEnabled || settings.shadowEnabled) {
    const worthReply = pick(DECISION_QUESTION_IDS.worthReply);
    if (worthReply) {
      questions[DECISION_QUESTION_IDS.worthReply] = worthReply;
    }
  }
  return questions;
}

/** 判定上下文（与 triage 缝同源；recent 由调用方截到 ≤8 条） */
export type DecisionContext = {
  triggerText: string;
  recentInboundTexts: readonly string[];
  chatType?: string | undefined;
};

/** 组装 state：消息文本截断（数据最小化口径，与 triage 同级保守） */
export function buildDecisionState(
  context: DecisionContext,
): Record<string, unknown> {
  return {
    trigger: context.triggerText.slice(0, 300),
    recent: context.recentInboundTexts
      .slice(-8)
      .map((text) => text.slice(0, 120)),
    ...(context.chatType ? { chatType: context.chatType } : {}),
  };
}

export type DecisionSeamResult =
  | { kind: "disabled" }
  | { kind: "skipped_empty_context" }
  | { kind: "failed"; errorCode: string }
  | ({ kind: "ok" } & DecisionCallSuccess);

/**
 * 执行一次缝判定：空上下文守卫（trigger 与 recent 全空 → 跳过，fail-open
 * 不得对空 state 下判）、问题集为空 → disabled、其余折叠为 failed/ok。
 * 永不抛错。
 */
export async function classifyWithDecisionModel(input: {
  endpoint: DecisionModelEndpoint;
  settings: DecisionSettings;
  context: DecisionContext;
  fetchImpl?: typeof fetch | undefined;
}): Promise<DecisionSeamResult> {
  if (!isDecisionSeamActive(input.settings)) return { kind: "disabled" };
  if (
    input.context.triggerText.trim() === "" &&
    input.context.recentInboundTexts.length === 0
  ) {
    return { kind: "skipped_empty_context" };
  }
  const questions = buildDecisionQuestions(input.settings);
  if (Object.keys(questions).length === 0) return { kind: "disabled" };
  const result = await callDecisionModel(
    { ...input.endpoint, timeoutMs: input.settings.timeoutMs },
    {
      state: buildDecisionState(input.context),
      questions,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    },
  );
  return result.ok
    ? { kind: "ok", ...result }
    : { kind: "failed", errorCode: result.errorCode };
}

export type DecisionTriageVerdict = {
  route: "human" | "auto";
  tier: "simple" | "standard";
  reason: string;
  needHumanProbability?: number | undefined;
  simpleProbability?: number | undefined;
};

/**
 * 阈值映射（方案 Phase 1）：P(need_human)≥阈值且置信度达标 → 转人工；
 * P(tier=simple)≥阈值 → 直答档；灰区一律 standard 主决策。confidence
 * 缺省（noul 未承诺）视为达标——阈值门只在有置信度时加严。
 */
export function verdictFromDecision(
  result: Extract<DecisionSeamResult, { kind: "ok" }>,
  settings: DecisionSettings,
): DecisionTriageVerdict {
  const needHumanAnswer = result.answers[DECISION_QUESTION_IDS.needHuman];
  const needHumanP = readNoulProbability(needHumanAnswer) ?? 0;
  const needHumanConfidence = readDecisionConfidence(needHumanAnswer);
  const confidenceOk =
    needHumanConfidence === undefined ||
    needHumanConfidence >= settings.thresholds.humanConfidence;
  if (needHumanP >= settings.thresholds.humanProbability && confidenceOk) {
    return {
      route: "human",
      tier: "standard",
      reason: "decision_need_human",
      needHumanProbability: needHumanP,
    };
  }
  const tierAnswer = result.answers[DECISION_QUESTION_IDS.tier];
  const simpleP =
    readChoiceProbability(tierAnswer, "simple") ??
    (tierAnswer?.answer === "simple" ? 1 : 0);
  if (simpleP >= settings.thresholds.simpleProbability) {
    return {
      route: "auto",
      tier: "simple",
      reason: "decision_simple",
      needHumanProbability: needHumanP,
      simpleProbability: simpleP,
    };
  }
  return {
    route: "auto",
    tier: "standard",
    reason: "decision_standard",
    needHumanProbability: needHumanP,
    simpleProbability: simpleP,
  };
}

/**
 * worth-reply 判定：P(值得回复) ≤ 1-noReplyProbability（即 P(不值得)≥
 * 阈值，出厂 0.9）→ true（跳过主决策）。回包缺失视为不跳（fail-open）。
 */
export function shouldSkipForWorthReply(
  result: Extract<DecisionSeamResult, { kind: "ok" }>,
  settings: DecisionSettings,
): boolean {
  const worthP = readNoulProbability(
    result.answers[DECISION_QUESTION_IDS.worthReply],
  );
  if (worthP === undefined) return false;
  // 1e-9 吸收浮点误差（1-0.9=0.0999…98，否则恰在阈值上的 0.1 漏判）
  return worthP <= 1 - settings.thresholds.noReplyProbability + 1e-9;
}

/** 审计 payload（成功）：概率/延迟/token/实测模型名；apiKey 永不落盘 */
export function decisionAuditPayload(
  result: Extract<DecisionSeamResult, { kind: "ok" }>,
): Record<string, unknown> {
  return {
    answers: result.answers,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
    model: result.model,
  };
}

// ── Phase 3：异步旁路（handoff 评分 / 记忆预判）────────────────────────

/**
 * score 判定 → 业务优先级：score 是 0-indexed 加权期望（criteria 数组
 * 下标轴），映射到 1..档数；四舍五入后钳位。回包缺失返回 undefined
 * （调用方 fail-open = 不评分，排序语义与未接入一致）。
 */
export function mapUrgencyToPriority(
  answer: DecisionAnswerLike | undefined,
  levelCount: number,
): number | undefined {
  const raw =
    typeof answer?.score === "number" && Number.isFinite(answer.score)
      ? answer.score
      : typeof answer?.answer === "number" && Number.isFinite(answer.answer)
        ? answer.answer
        : undefined;
  if (raw === undefined) return undefined;
  const priority = Math.round(raw) + 1;
  return Math.min(Math.max(priority, 1), Math.max(levelCount, 1));
}

/** score 回包的宽松读取形态（与 client 的 DecisionAnswer 结构兼容） */
type DecisionAnswerLike = {
  answer?: unknown;
  score?: unknown;
};

/**
 * handoff 待认领队列异步评分（fire-and-forget）：
 * - 仅当 settings 配置了 q_urgency（score）才动作；会话当前 handoff 非
 *   pending（已认领/已解决）不评分；
 * - 任何失败静默放弃 = 无分 = 排序语义与未接入一致（fail-open）；
 * - context 只喂触发期近 5 条入站（数据最小化口径同 triage）。
 * 永不抛错。
 */
export function scoreHandoffAsync(input: {
  db: NodePgDatabase<typeof schema>;
  endpoint: DecisionModelEndpoint;
  settings: DecisionSettings;
  conversationId: string;
  fetchImpl?: typeof fetch | undefined;
}): void {
  void (async () => {
    try {
      const { and, desc, eq } = await import("drizzle-orm");
      const urgency =
        input.settings.questions[DECISION_QUESTION_IDS.urgency];
      if (urgency?.type !== "score") return;
      const [handoff] = await input.db
        .select({ status: schema.handoffStates.status })
        .from(schema.handoffStates)
        .where(
          eq(schema.handoffStates.conversationId, input.conversationId),
        )
        .limit(1);
      if (!handoff || handoff.status !== "pending") return;
      const recent = await input.db
        .select({ text: schema.messages.text })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.conversationId, input.conversationId),
            eq(schema.messages.direction, "inbound"),
          ),
        )
        .orderBy(desc(schema.messages.occurredAt))
        .limit(5);
      // 直接单问调用（紧急度不在 triage 缝问题集里，不走 classifyWithDecisionModel）
      const call = await callDecisionModel(
        { ...input.endpoint, timeoutMs: input.settings.timeoutMs },
        {
          state: {
            recent: recent
              .slice(-5)
              .map((row) => row.text.slice(0, 120)),
          },
          questions: { [DECISION_QUESTION_IDS.urgency]: urgency },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        },
      );
      if (!call.ok) return;
      const levelCount = Array.isArray(urgency.criteria)
        ? urgency.criteria.length
        : 5;
      const priority = mapUrgencyToPriority(
        call.answers[DECISION_QUESTION_IDS.urgency] as DecisionAnswerLike,
        levelCount,
      );
      if (priority === undefined) return;
      await input.db
        .update(schema.handoffStates)
        .set({ priority, priorityScoredAt: new Date() })
        .where(
          and(
            eq(schema.handoffStates.conversationId, input.conversationId),
            eq(schema.handoffStates.status, "pending"),
          ),
        );
    } catch {
      // fail-open：评分失败 = 无分 = 现状排序
    }
  })();
}

/**
 * 记忆捕获价值预判：P(含值得记的事实) < memoryProbability（默认 0.5）→
 * true（跳过提取）。问题未配置 / 回包缺失 / 任何异常 → false（照常提取，
 * fail-open）。messages 为本批待提取文本（调用方裁剪，各 ≤120 字）。
 */
export async function shouldSkipMemoryCapture(input: {
  endpoint: DecisionModelEndpoint;
  settings: DecisionSettings;
  messages: readonly string[];
  fetchImpl?: typeof fetch | undefined;
}): Promise<boolean> {
  try {
    const hasMemory =
      input.settings.questions[DECISION_QUESTION_IDS.hasMemory];
    if (hasMemory?.type !== "noul") return false;
    if (input.messages.length === 0) return false;
    const call = await callDecisionModel(
      { ...input.endpoint, timeoutMs: input.settings.timeoutMs },
      {
        state: {
          recent: input.messages.slice(-8).map((text) => text.slice(0, 120)),
        },
        questions: { [DECISION_QUESTION_IDS.hasMemory]: hasMemory },
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      },
    );
    if (!call.ok) return false;
    const answer = call.answers[DECISION_QUESTION_IDS.hasMemory];
    const p =
      readNoulProbability(answer) ??
      (typeof answer?.answer === "number" ? answer.answer : undefined);
    if (p === undefined) return false;
    return p < 0.5;
  } catch {
    return false;
  }
}

/** 完句判定结论：unknown = 判定不可用（调用方 fail-open 照常建轮） */
export type HalfSentenceVerdict = "finished" | "unfinished" | "unknown";

/**
 * Phase 4 收窗判定：客户想说的话说完整了吗。P(完整) ≥ 0.5 → finished；
 * < 0.5 → unfinished（续窗）；问题未配置 / 回包缺失 / 任何失败 →
 * unknown（照常建轮，与未接入一致）。
 */
export async function judgeMessageFinished(input: {
  endpoint: DecisionModelEndpoint;
  settings: DecisionSettings;
  messages: readonly string[];
  fetchImpl?: typeof fetch | undefined;
}): Promise<HalfSentenceVerdict> {
  try {
    const finished = input.settings.questions[DECISION_QUESTION_IDS.finished];
    if (finished?.type !== "noul") return "unknown";
    if (input.messages.length === 0) return "unknown";
    const call = await callDecisionModel(
      { ...input.endpoint, timeoutMs: input.settings.timeoutMs },
      {
        state: {
          recent: input.messages.slice(-8).map((text) => text.slice(0, 120)),
        },
        questions: { [DECISION_QUESTION_IDS.finished]: finished },
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      },
    );
    if (!call.ok) return "unknown";
    const answer = call.answers[DECISION_QUESTION_IDS.finished];
    const p =
      readNoulProbability(answer) ??
      (typeof answer?.answer === "number" ? answer.answer : undefined);
    if (p === undefined) return "unknown";
    return p >= 0.5 ? "finished" : "unfinished";
  } catch {
    return "unknown";
  }
}

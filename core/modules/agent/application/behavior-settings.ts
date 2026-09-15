/**
 * Agent 行为参数（R2 设置中心 · AI员工分区 · 行为参数）。
 *
 * 会话 TTL / 轮数上限 / wait 上限 / nudge 话术 / ReAct 步数预算此前是
 * 代码常量（agent-session.ts / decision-disposition.ts / turn-runner.ts），
 * 现在提升为 Solution 扩展设置（solution.extension_settings，键 behavior），
 * 与 pipeline / groupChat 并列存储。存储形状：
 *
 *   { behavior: { sessionTtlMinutes, sessionRoundBudget,
 *                 defaultWaitMs, nudgeText, toolStepBudget,
 *                 decisionStepBudget, replyStepBudget } }
 *
 * 读取路径：带 TTL 缓存的扩展设置读取器（createCachedExtensionSettingsReader）
 * + 本模块的容错提取。任何缺失/畸形/越界字段逐项回落出厂默认（fail-safe），
 * 与未配置时的行为逐字节一致——绝不因配置异常阻断 Turn 处理。
 *
 * Core 保持业务中立：本模块不知道任何业务词，只消费数值与文本。
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { createCachedExtensionSettingsReader } from "../../../infrastructure/settings/extension-settings.js";

/** 轮窗摘要角色标签（round-window.ts 摘要行两端的角色词；ADR-0011）。 */
export type RoundSummaryLabels = { customer: string; agent: string };

/** 引擎出厂标签：渠道中立措辞；业务词（如 客户/客服）由部署种子下发。 */
export const DEFAULT_ROUND_SUMMARY_LABELS: RoundSummaryLabels = {
  customer: "customer",
  agent: "assistant",
};

/** 出厂默认：与会话模式引擎交付时的代码常量逐字节一致。 */
export const DEFAULT_BEHAVIOR_SETTINGS = {
  /** 会话片段 TTL（分钟）：超时强制收束（默认 45 分钟）。 */
  sessionTtlMinutes: 45,
  /** 每会话轮数上限（默认 24）。 */
  sessionRoundBudget: 24,
  /** wait 决策缺省等待时长（毫秒，模型未给 wait_ms 时；默认 5 分钟）。 */
  defaultWaitMs: 300_000,
  /** wait 唤醒的预承诺 nudge 话术；空 = 不代发（模型自带 nudge_text 优先）。 */
  nudgeText: "",
  /**
   * 转人工兜底提醒话术：pending 无人认领超过 handoffReminderDelayMs 时
   * 由系统代发一条轻提示；空 = 关闭（默认，失败路径转人工保持静默）。
   */
  handoffReminderText: "",
  /** 转人工兜底提醒的等待时长（毫秒），仅 handoffReminderText 非空时生效。 */
  handoffReminderDelayMs: 120_000,
  /** 单个 Agent Turn 内的最大工具步数（有界 ReAct 预算）。 */
  toolStepBudget: 4,
  /**
   * 单个 Agent Turn 内的最大决策步数（模型调用次数，含工具前后的决策；
   * 真 ReAct 循环预算，代码持有，模型不可绕过）。
   */
  decisionStepBudget: 8,
  /**
   * 单个 Agent Turn 内的最大续步回复批数（reply 不带 wait_ms 的中间说话）；
   * 超过后该批回复照常发出但回合收口——防刷屏硬顶。
   */
  replyStepBudget: 2,
  /**
   * 定时发送护栏（SCHEDULED-SEND-PLAN 决策 #7）：
   * 单联系人 pending 上限 / 单联系人每日直发上限 / 静音时段（顺延至 quietEndHour）。
   */
  scheduledSendMaxPending: 2,
  scheduledSendMaxPerDay: 10,
  scheduledSendQuietStartHour: 22,
  scheduledSendQuietEndHour: 8,
  /**
   * 轮窗摘要角色标签（ADR-0011）：更早回合摘要行「… 客户：…｜客服：…」
   * 的两个角色词。引擎缺省中立（customer/assistant），业务词由部署种子
   * 或设置中心下发（behavior.roundSummaryLabels）。
   */
  roundSummaryLabels: DEFAULT_ROUND_SUMMARY_LABELS,
} as const;

export type BehaviorSettings = {
  sessionTtlMinutes: number;
  sessionRoundBudget: number;
  defaultWaitMs: number;
  nudgeText: string;
  handoffReminderText: string;
  handoffReminderDelayMs: number;
  toolStepBudget: number;
  decisionStepBudget: number;
  replyStepBudget: number;
  scheduledSendMaxPending: number;
  scheduledSendMaxPerDay: number;
  scheduledSendQuietStartHour: number;
  scheduledSendQuietEndHour: number;
  roundSummaryLabels: RoundSummaryLabels;
};

/** 数值字段约束：min/max 与原代码常量的合法域一致。 */
const LIMITS = {
  sessionTtlMinutes: { min: 5, max: 24 * 60 },
  sessionRoundBudget: { min: 1, max: 200 },
  defaultWaitMs: { min: 30_000, max: 15 * 60_000 },
  handoffReminderDelayMs: { min: 30_000, max: 30 * 60_000 },
  toolStepBudget: { min: 1, max: 12 },
  decisionStepBudget: { min: 1, max: 24 },
  replyStepBudget: { min: 1, max: 4 },
  scheduledSendMaxPending: { min: 0, max: 20 },
  scheduledSendMaxPerDay: { min: 0, max: 100 },
  scheduledSendQuietStartHour: { min: 0, max: 23 },
  scheduledSendQuietEndHour: { min: 0, max: 23 },
} as const;

function clampInt(
  value: unknown,
  limits: { min: number; max: number },
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < limits.min || rounded > limits.max) return fallback;
  return rounded;
}

/** 容错提取角色标签：非空字符串逐字段生效，越界/缺省回落中立默认。 */
function extractRoundSummaryLabels(source: unknown): RoundSummaryLabels {
  const fallback = DEFAULT_ROUND_SUMMARY_LABELS;
  if (typeof source !== "object" || source === null) return { ...fallback };
  const raw = source as Record<string, unknown>;
  const label = (value: unknown, alt: string): string =>
    typeof value === "string" && value.trim() !== "" && value.length <= 40
      ? value
      : alt;
  return {
    customer: label(raw.customer, fallback.customer),
    agent: label(raw.agent, fallback.agent),
  };
}

/**
 * 从扩展设置原始 JSON 容错提取行为参数。
 * 期望形状：{ behavior: {...} }；缺字段/类型不符/越界逐项回落默认。
 */
export function extractBehaviorSettings(raw: unknown): BehaviorSettings {
  const defaults = DEFAULT_BEHAVIOR_SETTINGS;
  const behavior =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>).behavior
      : undefined;
  if (typeof behavior !== "object" || behavior === null) {
    return { ...defaults };
  }
  const source = behavior as Record<string, unknown>;
  const nudgeText =
    typeof source.nudgeText === "string" && source.nudgeText.trim() !== ""
      ? source.nudgeText.trim()
      : defaults.nudgeText;
  const handoffReminderText =
    typeof source.handoffReminderText === "string" &&
    source.handoffReminderText.trim() !== ""
      ? source.handoffReminderText.trim()
      : defaults.handoffReminderText;
  return {
    sessionTtlMinutes: clampInt(
      source.sessionTtlMinutes,
      LIMITS.sessionTtlMinutes,
      defaults.sessionTtlMinutes,
    ),
    sessionRoundBudget: clampInt(
      source.sessionRoundBudget,
      LIMITS.sessionRoundBudget,
      defaults.sessionRoundBudget,
    ),
    defaultWaitMs: clampInt(
      source.defaultWaitMs,
      LIMITS.defaultWaitMs,
      defaults.defaultWaitMs,
    ),
    nudgeText,
    handoffReminderText,
    handoffReminderDelayMs: clampInt(
      source.handoffReminderDelayMs,
      LIMITS.handoffReminderDelayMs,
      defaults.handoffReminderDelayMs,
    ),
    toolStepBudget: clampInt(
      source.toolStepBudget,
      LIMITS.toolStepBudget,
      defaults.toolStepBudget,
    ),
    decisionStepBudget: clampInt(
      source.decisionStepBudget,
      LIMITS.decisionStepBudget,
      defaults.decisionStepBudget,
    ),
    replyStepBudget: clampInt(
      source.replyStepBudget,
      LIMITS.replyStepBudget,
      defaults.replyStepBudget,
    ),
    scheduledSendMaxPending: clampInt(
      source.scheduledSendMaxPending,
      LIMITS.scheduledSendMaxPending,
      defaults.scheduledSendMaxPending,
    ),
    scheduledSendMaxPerDay: clampInt(
      source.scheduledSendMaxPerDay,
      LIMITS.scheduledSendMaxPerDay,
      defaults.scheduledSendMaxPerDay,
    ),
    scheduledSendQuietStartHour: clampInt(
      source.scheduledSendQuietStartHour,
      LIMITS.scheduledSendQuietStartHour,
      defaults.scheduledSendQuietStartHour,
    ),
    scheduledSendQuietEndHour: clampInt(
      source.scheduledSendQuietEndHour,
      LIMITS.scheduledSendQuietEndHour,
      defaults.scheduledSendQuietEndHour,
    ),
    roundSummaryLabels: extractRoundSummaryLabels(source.roundSummaryLabels),
  };
}

/**
 * 创建带 TTL 缓存的行为参数读取器（供 agent-worker / api 进程装配）。
 * 底层复用通用扩展设置读取器（30s TTL + in-flight 合并）。
 */
export function createBehaviorSettingsReader(
  db: NodePgDatabase<typeof schema>,
  input: { solutionId: string; extensionId: string; ttlMs?: number },
): () => Promise<BehaviorSettings> {
  const readRaw = createCachedExtensionSettingsReader(db, input);
  return async () => {
    try {
      return extractBehaviorSettings(await readRaw());
    } catch {
      return { ...DEFAULT_BEHAVIOR_SETTINGS };
    }
  };
}

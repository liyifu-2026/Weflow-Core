/**
 * Agent 行为参数（R2 设置中心 · AI员工分区 · 行为参数）。
 *
 * 会话 TTL / 轮数上限 / wait 上限 / nudge 话术 / ReAct 步数预算此前是
 * 代码常量（agent-session.ts / decision-disposition.ts / turn-runner.ts），
 * 现在提升为 Solution 扩展设置（solution.extension_settings，键 behavior），
 * 与 pipeline / groupChat 并列存储。存储形状：
 *
 *   { behavior: { sessionTtlMinutes, sessionRoundBudget,
 *                 defaultWaitMs, nudgeText, toolStepBudget } }
 *
 * 读取路径：带 TTL 缓存的扩展设置读取器（createCachedExtensionSettingsReader）
 * + 本模块的容错提取。任何缺失/畸形/越界字段逐项回落出厂默认（fail-safe），
 * 与未配置时的行为逐字节一致——绝不因配置异常阻断 Turn 处理。
 *
 * Core 保持业务中立：本模块不知道任何业务词，只消费数值与文本。
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { createCachedExtensionSettingsReader } from "../../solution/application/read-extension-settings.js";

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
  /** 单个 Agent Turn 内的最大工具步数（有界 ReAct 预算）。 */
  toolStepBudget: 4,
} as const;

export type BehaviorSettings = {
  sessionTtlMinutes: number;
  sessionRoundBudget: number;
  defaultWaitMs: number;
  nudgeText: string;
  toolStepBudget: number;
};

/** 数值字段约束：min/max 与原代码常量的合法域一致。 */
const LIMITS = {
  sessionTtlMinutes: { min: 5, max: 24 * 60 },
  sessionRoundBudget: { min: 1, max: 200 },
  defaultWaitMs: { min: 30_000, max: 15 * 60_000 },
  toolStepBudget: { min: 1, max: 12 },
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
    toolStepBudget: clampInt(
      source.toolStepBudget,
      LIMITS.toolStepBudget,
      defaults.toolStepBudget,
    ),
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

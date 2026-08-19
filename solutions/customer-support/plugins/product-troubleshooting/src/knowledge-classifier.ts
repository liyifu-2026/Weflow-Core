/**
 * 知识证据分类模块(纯函数)
 *
 * 第一阶段只做"结构化、高置信"的匹配分类与冲突检测:
 * - 依据 score 与数量区分 no_result / weak_match / single_strong_match /
 *   multiple_consistent / potential_conflict
 * - 仅当多个强匹配对同一结构化槽位(版本号/错误码)给出互斥值时判定 potential_conflict
 * - 不同文档的措辞差异不算冲突;复杂语义冲突交给 Evaluation / 后续能力
 *
 * 知识不足(no_result)≠ 自动转人工:是否继续推进由 Planner 结合 Case State 决定。
 */

import type { KnowledgeEvidence } from "@weflow/contracts";

export type KnowledgeMatchState =
  | "no_result"
  | "weak_match"
  | "single_strong_match"
  | "multiple_consistent"
  | "potential_conflict";

export type SlotConflict = {
  slot: string;
  values: string[];
  sources: string[];
};

export type KnowledgeClassification = {
  state: KnowledgeMatchState;
  strongCount: number;
  conflicts: SlotConflict[];
};

/** 强匹配阈值:score ≥ 该值视为可信证据 */
export const KNOWLEDGE_STRONG_SCORE = 0.6;

/** 结构化槽位提取:仅版本号与错误码(与事实抽取保持一致) */
const SLOT_EXTRACTORS: Record<string, (content: string) => string | undefined> =
  {
    software_version: (content) =>
      content.match(/\bV\d+(?:\.\d+){0,3}\b/i)?.[0]?.toUpperCase(),
    error_code: (content) =>
      content.match(
        /(?:错误(?:代码|码)|error\s*code)\s*[:：]?\s*([A-Za-z]?\d{3,})/i,
      )?.[1],
  };

/** 版本兼容判定:V9 与 V9.2.1 视为兼容,不构成冲突 */
function versionsConflict(a: string, b: string): boolean {
  const parse = (value: string) =>
    value.replace(/^v/i, "").split(".").map(Number);
  const left = parse(a);
  const right = parse(b);
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return true;
  }
  return false;
}

/** 同槽位两个值是否互斥 */
function slotValuesConflict(slot: string, a: string, b: string): boolean {
  if (slot === "software_version") return versionsConflict(a, b);
  return a !== b;
}

/**
 * 分类检索证据。
 * potential_conflict 仅由"多个强匹配对同一槽位给出互斥值"触发。
 */
export function classifyKnowledgeEvidence(
  evidence: KnowledgeEvidence[],
): KnowledgeClassification {
  if (evidence.length === 0) {
    return { state: "no_result", strongCount: 0, conflicts: [] };
  }
  const strong = evidence.filter(
    (item) => item.score >= KNOWLEDGE_STRONG_SCORE,
  );
  if (strong.length === 0) {
    return { state: "weak_match", strongCount: 0, conflicts: [] };
  }
  if (strong.length === 1) {
    return { state: "single_strong_match", strongCount: 1, conflicts: [] };
  }
  // 多个强匹配:检测结构化槽位冲突
  const conflicts: SlotConflict[] = [];
  for (const [slot, extract] of Object.entries(SLOT_EXTRACTORS)) {
    const byValue = new Map<string, string[]>();
    for (const item of strong) {
      const value = extract(item.content);
      if (!value) continue;
      const sources = byValue.get(value) ?? [];
      sources.push(item.title || item.knowledgeId);
      byValue.set(value, sources);
    }
    const values = [...byValue.keys()];
    const conflictingPair = values.some((a) =>
      values.some((b) => a !== b && slotValuesConflict(slot, a, b)),
    );
    if (conflictingPair) {
      conflicts.push({
        slot,
        values,
        sources: values.flatMap((value) => byValue.get(value) ?? []),
      });
    }
  }
  return {
    state: conflicts.length > 0 ? "potential_conflict" : "multiple_consistent",
    strongCount: strong.length,
    conflicts,
  };
}

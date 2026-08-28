/**
 * 确定性 Question Validator(纯函数)
 *
 * 作用:校验 Planner 声明的每个询问是否与 Case State 一致。
 * - 严格 reason 语义:声明的 reason 必须与事实状态对应,Validator 不做自动解释
 * - 普通行为错误(不必要重复询问 / 无效 reason / 近期已问)被"修剪"出来,
 *   由上层(process-agent-turn)决定继续、一次性纠正或安全回退,而非杀死整个 Turn
 * - 只有真正的安全错误(Phase D 起)才进入 fatal 阻断
 *
 * 本模块只做决策,不写库、不调模型。
 */

import type {
  AskedFieldRecord,
  CaseFact,
  CaseFactGranularity,
  CaseFacts,
} from "@weflow-leaif/contracts";
import {
  DEFAULT_SUBJECT,
  factKey,
  getFact,
  GRANULARITY_RANK,
} from "./case-facts.js";

export type QuestionReason =
  | "missing"
  | "conflict"
  | "stale"
  | "insufficient_specificity"
  | "subject_changed"
  | "critical_reconfirmation";

export type QuestionInput = {
  field: string;
  subject?: string | undefined;
  reason: QuestionReason;
  requiresGranularity?: CaseFactGranularity | undefined;
};

export type AskedRecord = AskedFieldRecord;

export type QuestionVerdict =
  | {
      verdict: "accepted";
      question: QuestionInput;
      event:
        | "question_allowed_missing"
        | "question_allowed_conflict"
        | "question_allowed_stale"
        | "question_allowed_specificity"
        | "question_allowed_subject_change"
        | "question_allowed_critical_reconfirmation";
      reasonCode: null;
    }
  | {
      verdict: "suppressed";
      question: QuestionInput;
      event:
        "question_suppressed_known_fact" | "question_suppressed_recently_asked";
      reasonCode: "unnecessary_reask" | "recently_asked";
    }
  | {
      verdict: "rejected";
      question: QuestionInput;
      event: "question_rejected_invalid_reason";
      reasonCode: "invalid_reason";
    };

export type QuestionValidationResult = {
  accepted: QuestionVerdict[];
  suppressed: QuestionVerdict[];
  rejected: QuestionVerdict[];
};

/** 近期询问抑制窗口:10 分钟(墙钟)+ 事实自 askedAt 未变化 */
export const RECENT_ASK_WINDOW_MS = 10 * 60_000;
/** 询问记录保留:24 小时内、最多 50 条 */
const ASKED_KEEP_MS = 24 * 60 * 60_000;
const ASKED_KEEP_MAX = 50;

export type CriticalOperation = { toolName: string; argumentKeys?: string[] };

/**
 * 配置化关键操作清单:critical_reconfirmation 的确定性门控依据。
 * 默认空(当前工具目录只读,天然安全);新增破坏性工具时在此登记。
 */
export const CRITICAL_OPERATIONS: CriticalOperation[] = [];

/** 判断当前 tool plan 是否属于关键操作(tool 名 + 必需参数键) */
export function detectCriticalOp(
  toolPlan:
    { name: string; arguments: Record<string, string> } | null | undefined,
  operations: CriticalOperation[] = CRITICAL_OPERATIONS,
): boolean {
  if (!toolPlan) return false;
  return operations.some((operation) => {
    if (operation.toolName !== toolPlan.name) return false;
    if (!operation.argumentKeys || operation.argumentKeys.length === 0) {
      return true;
    }
    return operation.argumentKeys.every((key) => key in toolPlan.arguments);
  });
}

/** 事实粒度是否低于所需粒度;事实无粒度元数据视为足够 */
export function granularityBelow(
  fact: CaseFact,
  required: CaseFactGranularity | undefined,
): boolean {
  if (!required || !fact.granularity) return false;
  return GRANULARITY_RANK[fact.granularity] < GRANULARITY_RANK[required];
}

/** 是否存在其它 subject 下的 confirmed 同名字段事实 */
function otherSubjectConfirmed(
  facts: CaseFacts,
  field: string,
  subject: string,
): boolean {
  return Object.entries(facts).some(
    ([key, fact]) =>
      fact.subject !== subject &&
      fact.status === "confirmed" &&
      factKey(field, fact.subject) === key,
  );
}

/** 近期是否问过同一 (field, subject) 且事实自 askedAt 未变化 */
export function recentlyAsked(
  facts: CaseFacts,
  askedFields: AskedFieldRecord[],
  field: string,
  subject: string,
  now: string,
): boolean {
  const latest = [...askedFields]
    .reverse()
    .find((record) => record.field === field && record.subject === subject);
  if (!latest) return false;
  const elapsed = Date.parse(now) - Date.parse(latest.askedAt);
  if (!Number.isFinite(elapsed) || elapsed > RECENT_ASK_WINDOW_MS) return false;
  const fact = getFact(facts, field, subject);
  if (fact) {
    return (
      !fact.lastChangedAt ||
      Date.parse(fact.lastChangedAt) <= Date.parse(latest.askedAt)
    );
  }
  // 字段仍缺失:仅在询问时也缺失(未作答)时视为"没变化"
  return latest.factValueAtAsk === null;
}

type TrueState =
  "absent" | "uncertain" | "conflict" | "stale" | "specificity" | "known_fact";

function trueStateOf(
  facts: CaseFacts,
  question: QuestionInput,
): { state: TrueState; fact: CaseFact | undefined } {
  const subject = question.subject ?? DEFAULT_SUBJECT;
  const fact = getFact(facts, question.field, subject);
  if (!fact) return { state: "absent", fact: undefined };
  if (fact.status === "uncertain") return { state: "uncertain", fact };
  if (fact.status === "conflicted") return { state: "conflict", fact };
  if (fact.status === "invalidated") return { state: "stale", fact };
  if (granularityBelow(fact, question.requiresGranularity)) {
    return { state: "specificity", fact };
  }
  return { state: "known_fact", fact };
}

/**
 * 校验一组询问,返回 accepted / suppressed / rejected 三桶。
 * 严格 reason 语义;missing 且事实已确认 → suppressed(unnecessary_reask)。
 */
export function validateQuestions(
  state: {
    facts: CaseFacts;
    askedFields: AskedFieldRecord[];
    criticalOpDetected: boolean;
    now: string;
  },
  questions: QuestionInput[],
): QuestionValidationResult {
  const result: QuestionValidationResult = {
    accepted: [],
    suppressed: [],
    rejected: [],
  };
  for (const question of questions) {
    const subject = question.subject ?? DEFAULT_SUBJECT;
    const verdict = validateOne(state, question, subject);
    if (verdict.verdict === "accepted") result.accepted.push(verdict);
    else if (verdict.verdict === "suppressed") result.suppressed.push(verdict);
    else result.rejected.push(verdict);
  }
  return result;
}

function validateOne(
  state: {
    facts: CaseFacts;
    askedFields: AskedFieldRecord[];
    criticalOpDetected: boolean;
    now: string;
  },
  question: QuestionInput,
  subject: string,
): QuestionVerdict {
  if (question.reason === "critical_reconfirmation") {
    if (state.criticalOpDetected) {
      return {
        verdict: "accepted",
        question,
        event: "question_allowed_critical_reconfirmation",
        reasonCode: null,
      };
    }
    return reject(question);
  }
  if (
    recentlyAsked(
      state.facts,
      state.askedFields,
      question.field,
      subject,
      state.now,
    )
  ) {
    return {
      verdict: "suppressed",
      question,
      event: "question_suppressed_recently_asked",
      reasonCode: "recently_asked",
    };
  }
  const { state: trueState, fact } = trueStateOf(state.facts, question);
  if (question.reason === "missing") {
    if (trueState === "absent" || trueState === "uncertain") {
      return allow(question, "question_allowed_missing");
    }
    if (trueState === "known_fact") {
      // 已确认且无任何合法重新询问条件 → 不必要重复询问
      return {
        verdict: "suppressed",
        question,
        event: "question_suppressed_known_fact",
        reasonCode: "unnecessary_reask",
      };
    }
    // 事实是 stale/conflict/specificity,却声明 missing → 严格拒绝,交给上层纠正
    return reject(question);
  }
  switch (question.reason) {
    case "conflict":
      return trueState === "conflict"
        ? allow(question, "question_allowed_conflict")
        : reject(question);
    case "stale":
      return trueState === "stale"
        ? allow(question, "question_allowed_stale")
        : reject(question);
    case "insufficient_specificity":
      return trueState === "specificity"
        ? allow(question, "question_allowed_specificity")
        : reject(question);
    case "subject_changed": {
      const otherHolds =
        fact === undefined &&
        otherSubjectConfirmed(state.facts, question.field, subject);
      return otherHolds
        ? allow(question, "question_allowed_subject_change")
        : reject(question);
    }
  }
}

type AcceptedEvent =
  | "question_allowed_missing"
  | "question_allowed_conflict"
  | "question_allowed_stale"
  | "question_allowed_specificity"
  | "question_allowed_subject_change"
  | "question_allowed_critical_reconfirmation";

function allow(question: QuestionInput, event: AcceptedEvent): QuestionVerdict {
  return { verdict: "accepted", question, event, reasonCode: null };
}

function reject(question: QuestionInput): QuestionVerdict {
  return {
    verdict: "rejected",
    question,
    event: "question_rejected_invalid_reason",
    reasonCode: "invalid_reason",
  };
}

/**
 * 预调用注入:确定性列出"禁止再次询问"的字段(已确认事实 + 近期已问字段)。
 * 仅为预防性提示,不构成硬门。
 */
export function forbiddenAskFields(
  facts: CaseFacts,
  askedFields: AskedFieldRecord[],
  now: string,
): string[] {
  const fields = new Set<string>();
  for (const [key, fact] of Object.entries(facts)) {
    if (fact.status === "confirmed") fields.add(key);
  }
  const windowStart = Date.parse(now) - RECENT_ASK_WINDOW_MS;
  for (const record of askedFields) {
    if (Date.parse(record.askedAt) >= windowStart) {
      fields.add(factKey(record.field, record.subject));
    }
  }
  return [...fields];
}

/** 记录一次允许的询问(裁剪:保留 24 小时内、最多 50 条) */
export function recordAskedField(
  askedFields: AskedFieldRecord[],
  entry: AskedFieldRecord,
  now: string,
): AskedFieldRecord[] {
  const cutoff = Date.parse(now) - ASKED_KEEP_MS;
  const fresh = askedFields.filter(
    (record) => Date.parse(record.askedAt) >= cutoff,
  );
  return [...fresh, entry].slice(-ASKED_KEEP_MAX);
}

/**
 * Product troubleshooting business seam.
 *
 * This module makes only product-failure knowledge routing decisions. It has
 * no database access and does not own Case, Message, Turn, Tool, or Handoff
 * writes; the Agent application remains the coordinator for those effects.
 */

import type {
  ActionRecord,
  AskedFieldRecord,
  CaseFacts,
  KnowledgeEvidence,
} from "@weflow-leaif/contracts";
import {
  classifyKnowledgeEvidence,
  type KnowledgeClassification,
} from "./knowledge-classifier.js";
import {
  applyFactUpdates,
  confirmedFactValues,
  DEFAULT_SUBJECT,
  getFact,
  normalizeCaseFacts,
  type CaseFactUpdate,
} from "./case-facts.js";
import { rejectedOrFailedActions } from "./action-history.js";
import { extractConfirmedFacts } from "./extract-confirmed-facts.js";
import { recentlyAsked } from "./question-validator.js";

export type TroubleshootingCategory =
  | "startup_failure"
  | "antivirus_or_quarantine"
  | "compatibility"
  | "error"
  | "generic_failure";

export type TroubleshootingFactField =
  "software_version" | "error_code" | "device_model";

export type TroubleshootingFactRequirement = {
  field: TroubleshootingFactField;
  reason:
    "diagnostic_anchor" | "compatibility_version" | "compatibility_device";
  required: true;
  satisfied: boolean;
  askable: boolean;
};

export type TroubleshootingQuestionCandidate = {
  field: TroubleshootingFactField;
  reason:
    "diagnostic_anchor" | "compatibility_version" | "compatibility_device";
  priority: number;
};

export type ProductTroubleshootingInput = {
  currentMessage?: string | undefined;
  recentUserMessages: readonly string[];
  knownFields: Record<string, string> | CaseFacts;
  askedFields?: readonly AskedFieldRecord[];
  subject?: string | undefined;
  actionHistory?: readonly ActionRecord[];
  now?: string;
};

export type ProductTroubleshootingBeforeKnowledgeDecision = {
  isTroubleshooting: boolean;
  shouldRetrieveKnowledge: boolean;
  routingReason: "symptom" | "human_request" | "no_symptom";
  category: TroubleshootingCategory | null;
  requiredFacts: TroubleshootingFactRequirement[];
  missingFacts: TroubleshootingFactField[];
  askableFacts: TroubleshootingFactField[];
  knowledgeReady: boolean;
  questionCandidate: TroubleshootingQuestionCandidate | null;
  knowledgeQuery: string;
  blockedActions: string[];
};

export type TroubleshootingNextStepKind =
  | "ask_for_fact"
  | "provide_troubleshooting_step"
  | "request_more_evidence"
  | "recommend_escalation";

export type TroubleshootingNextStepCandidate = {
  kind: TroubleshootingNextStepKind;
  reason:
    | "missing_required_fact"
    | "no_knowledge_result"
    | "weak_knowledge_result"
    | "strong_knowledge_result"
    | "knowledge_conflict"
    | "no_safe_unused_action";
  preferredFact: TroubleshootingQuestionCandidate | null;
  preferredAction: string | null;
  blockedActions: string[];
};

export type ProductTroubleshootingAfterKnowledgeInput = {
  evidence: readonly KnowledgeEvidence[];
  actionHistory?: readonly ActionRecord[];
  currentMessage?: string | undefined;
  recentUserMessages?: readonly string[];
  knownFields?: Record<string, string> | CaseFacts;
  askedFields?: readonly AskedFieldRecord[];
  subject?: string | undefined;
  now?: string;
};

export type ProductTroubleshootingAfterKnowledgeDecision = {
  knowledge: KnowledgeClassification;
  blockedActions: string[];
  questionCandidate: TroubleshootingQuestionCandidate | null;
  nextStepCandidate: TroubleshootingNextStepCandidate | null;
};

const KNOWLEDGE_SYMPTOMS =
  /打不开|无法启动|启动失败|报错|错误码|错误代码|杀毒|隔离|删除|文件缺失|安装失败|兼容|闪退|崩溃|故障/;
const HUMAN_REQUEST = /转人工|人工客服|真人客服|找人工/;
const STARTUP_FAILURE = /打不开|无法启动|启动失败|闪退|崩溃/;
const ANTIVIRUS_OR_QUARANTINE = /杀毒|隔离|删除|文件缺失/;
const COMPATIBILITY = /兼容/;
const ERROR = /报错|错误码|错误代码/;
const TROUBLESHOOTING_ACTION_PATTERNS = [
  { action: "restore_quarantined_file", pattern: /恢复.*隔离|隔离.*恢复/ },
  { action: "reinstall", pattern: /重装|重新安装|reinstall/i },
  { action: "restart", pattern: /重启|restart/i },
] as const;

function categoryFor(text: string): TroubleshootingCategory {
  if (ANTIVIRUS_OR_QUARANTINE.test(text)) return "antivirus_or_quarantine";
  if (COMPATIBILITY.test(text)) return "compatibility";
  if (STARTUP_FAILURE.test(text)) return "startup_failure";
  if (ERROR.test(text)) return "error";
  return "generic_failure";
}

function requirementFieldsFor(
  category: TroubleshootingCategory,
): Array<Pick<TroubleshootingFactRequirement, "field" | "reason">> {
  if (category === "antivirus_or_quarantine") return [];
  if (category === "compatibility") {
    return [
      { field: "software_version", reason: "compatibility_version" },
      { field: "device_model", reason: "compatibility_device" },
    ];
  }
  // 现有行为只证明版本或错误码是排障检索的诊断锚点，二者是“至少一个”关系。
  return [
    { field: "software_version", reason: "diagnostic_anchor" },
    { field: "error_code", reason: "diagnostic_anchor" },
  ];
}

function evaluateFactRequirements(input: {
  category: TroubleshootingCategory;
  facts: CaseFacts;
  askedFields: readonly AskedFieldRecord[];
  subject: string;
  now: string;
}): Pick<
  ProductTroubleshootingBeforeKnowledgeDecision,
  "requiredFacts" | "missingFacts" | "askableFacts" | "knowledgeReady"
> {
  const fields = requirementFieldsFor(input.category);
  const requiredFacts = fields.map((requirement) => {
    const satisfied =
      getFact(input.facts, requirement.field, input.subject)?.status ===
      "confirmed";
    const askable =
      !satisfied &&
      !recentlyAsked(
        input.facts,
        [...input.askedFields],
        requirement.field,
        input.subject,
        input.now,
      );
    return { ...requirement, required: true as const, satisfied, askable };
  });

  const missingFacts = requiredFacts
    .filter((requirement) => !requirement.satisfied)
    .map((requirement) => requirement.field);
  const askableFacts = requiredFacts
    .filter((requirement) => !requirement.satisfied && requirement.askable)
    .map((requirement) => requirement.field);
  const knowledgeReady =
    input.category === "antivirus_or_quarantine"
      ? true
      : input.category === "compatibility"
        ? requiredFacts.every((requirement) => requirement.satisfied)
        : requiredFacts.some((requirement) => requirement.satisfied);

  return { requiredFacts, missingFacts, askableFacts, knowledgeReady };
}

function questionCandidateFor(input: {
  category: TroubleshootingCategory | null;
  currentMessage: string;
  requiredFacts: TroubleshootingFactRequirement[];
  askableFacts: TroubleshootingFactField[];
  knowledgeReady: boolean;
}): TroubleshootingQuestionCandidate | null {
  if (!input.category || input.knowledgeReady) return null;

  const preferredFields =
    input.category === "compatibility"
      ? (["software_version", "device_model"] as const)
      : /报错|错误码|错误代码/.test(input.currentMessage)
        ? (["error_code", "software_version"] as const)
        : (["software_version", "error_code"] as const);
  const askable = new Set(input.askableFacts);

  for (const [index, field] of preferredFields.entries()) {
    if (!askable.has(field)) continue;
    const requirement = input.requiredFacts.find(
      (candidate) => candidate.field === field,
    );
    if (!requirement) continue;
    return {
      field,
      reason: requirement.reason,
      priority: index + 1,
    };
  }
  return null;
}

function actionCandidatesFor(evidence: readonly KnowledgeEvidence[]): string[] {
  const source = evidence
    .map((item) => `${item.title} ${item.matchedContent} ${item.content}`)
    .join(" ");
  return TROUBLESHOOTING_ACTION_PATTERNS.filter(({ pattern }) =>
    pattern.test(source),
  ).map(({ action }) => action);
}

function nextStepCandidateFor(input: {
  knowledge: KnowledgeClassification;
  evidence: readonly KnowledgeEvidence[];
  troubleshootingBefore:
    ProductTroubleshootingBeforeKnowledgeDecision | undefined;
  blockedActions: string[];
}): TroubleshootingNextStepCandidate | null {
  const { troubleshootingBefore } = input;
  if (!troubleshootingBefore?.isTroubleshooting) return null;
  if (input.knowledge.state === "potential_conflict") {
    return {
      kind: "recommend_escalation",
      reason: "knowledge_conflict",
      preferredFact: null,
      preferredAction: null,
      blockedActions: input.blockedActions,
    };
  }
  if (
    input.knowledge.state === "single_strong_match" ||
    input.knowledge.state === "multiple_consistent"
  ) {
    const actionCandidates = actionCandidatesFor(input.evidence);
    const preferredAction = actionCandidates.find(
      (action) => !input.blockedActions.includes(action),
    );
    if (actionCandidates.length > 0 && !preferredAction) {
      return {
        kind: "recommend_escalation",
        reason: "no_safe_unused_action",
        preferredFact: null,
        preferredAction: null,
        blockedActions: input.blockedActions,
      };
    }
    return {
      kind: "provide_troubleshooting_step",
      reason: "strong_knowledge_result",
      preferredFact: null,
      preferredAction: preferredAction ?? null,
      blockedActions: input.blockedActions,
    };
  }
  if (input.knowledge.state === "weak_match") {
    if (troubleshootingBefore.questionCandidate) {
      return {
        kind: "ask_for_fact",
        reason: "missing_required_fact",
        preferredFact: troubleshootingBefore.questionCandidate,
        preferredAction: null,
        blockedActions: input.blockedActions,
      };
    }
    return {
      kind: "request_more_evidence",
      reason: "weak_knowledge_result",
      preferredFact: null,
      preferredAction: null,
      blockedActions: input.blockedActions,
    };
  }
  if (!troubleshootingBefore.questionCandidate) {
    return {
      kind: "recommend_escalation",
      reason: "no_knowledge_result",
      preferredFact: null,
      preferredAction: null,
      blockedActions: input.blockedActions,
    };
  }
  return {
    kind: "ask_for_fact",
    reason: "missing_required_fact",
    preferredFact: troubleshootingBefore.questionCandidate,
    preferredAction: null,
    blockedActions: input.blockedActions,
  };
}

/** Product troubleshooting seam for before/after knowledge decisions. */
export class ProductTroubleshootingSkill {
  public beforeKnowledge(
    input: ProductTroubleshootingInput,
  ): ProductTroubleshootingBeforeKnowledgeDecision {
    const currentMessage =
      input.currentMessage ?? input.recentUserMessages.at(-1) ?? "";
    const isTroubleshooting = KNOWLEDGE_SYMPTOMS.test(currentMessage);
    const isHumanRequest = HUMAN_REQUEST.test(currentMessage);
    const routingReason = isHumanRequest
      ? "human_request"
      : isTroubleshooting
        ? "symptom"
        : "no_symptom";
    const now = input.now ?? new Date().toISOString();
    const normalizedFacts = normalizeCaseFacts(input.knownFields, now);
    const subject = input.subject ?? DEFAULT_SUBJECT;
    const factMessages = [...input.recentUserMessages];
    if (currentMessage && factMessages.at(-1) !== currentMessage) {
      factMessages.push(currentMessage);
    }
    const extractedFactUpdates: CaseFactUpdate[] = extractConfirmedFacts(
      factMessages.map((content) => ({ role: "user", content })),
    );
    // 只在内存中应用本轮已明确表达的事实，复用 Case Fact 的状态语义，不写入状态。
    const effectiveFacts = applyFactUpdates(
      normalizedFacts,
      extractedFactUpdates,
      now,
    ).facts;
    const category = isTroubleshooting ? categoryFor(currentMessage) : null;
    const factRequirements = category
      ? evaluateFactRequirements({
          category,
          facts: effectiveFacts,
          askedFields: input.askedFields ?? [],
          subject,
          now,
        })
      : {
          requiredFacts: [],
          missingFacts: [],
          askableFacts: [],
          knowledgeReady: false,
        };
    const questionCandidate = questionCandidateFor({
      category,
      currentMessage,
      ...factRequirements,
    });
    const shouldRetrieveKnowledge =
      isTroubleshooting && !isHumanRequest && factRequirements.knowledgeReady;
    const recentUserMessages = input.recentUserMessages
      .slice(-3)
      .map((message) => message.trim())
      .filter(Boolean);
    const facts = Object.entries(confirmedFactValues(normalizedFacts))
      .map(([key, value]) => `${key}:${value}`)
      .join(" ");
    const source = recentUserMessages.join(" ");
    const expansions = [
      /杀毒|隔离|删除/.test(source) ? "杀毒软件隔离 文件恢复 信任列表" : "",
      /打不开|无法启动|启动失败/.test(source) ? "软件无法启动 排查步骤" : "",
    ].filter(Boolean);
    const query = [...recentUserMessages, facts, ...expansions]
      .filter(Boolean)
      .join(" ")
      .slice(0, 1_000);

    return {
      isTroubleshooting,
      shouldRetrieveKnowledge,
      routingReason,
      category,
      ...factRequirements,
      questionCandidate,
      knowledgeQuery: query,
      blockedActions: rejectedOrFailedActions(
        [...(input.actionHistory ?? [])],
        subject,
      ),
    };
  }

  public afterKnowledge(
    input: ProductTroubleshootingAfterKnowledgeInput,
  ): ProductTroubleshootingAfterKnowledgeDecision {
    const now = input.now ?? new Date().toISOString();
    const subject = input.subject ?? DEFAULT_SUBJECT;
    const currentMessage =
      input.currentMessage ?? input.recentUserMessages?.at(-1);
    const troubleshootingBefore = currentMessage
      ? this.beforeKnowledge({
          currentMessage,
          recentUserMessages: input.recentUserMessages ?? [currentMessage],
          knownFields: input.knownFields ?? {},
          subject,
          now,
          ...(input.askedFields ? { askedFields: input.askedFields } : {}),
          ...(input.actionHistory
            ? { actionHistory: input.actionHistory }
            : {}),
        })
      : undefined;
    const knowledge = classifyKnowledgeEvidence([...input.evidence]);
    const blockedActions = rejectedOrFailedActions(
      [...(input.actionHistory ?? [])],
      subject,
    );
    return {
      knowledge,
      blockedActions,
      questionCandidate: troubleshootingBefore?.questionCandidate ?? null,
      nextStepCandidate: nextStepCandidateFor({
        knowledge,
        evidence: input.evidence,
        troubleshootingBefore,
        blockedActions,
      }),
    };
  }
}

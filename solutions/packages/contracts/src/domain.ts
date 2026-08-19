/**
 * Shared domain types that must be usable by Solution plugins without importing
 * Core internals.
 */

export type CaseFactStatus =
  | "confirmed"
  | "uncertain"
  | "conflicted"
  | "invalidated";

export type CaseFactSource = "customer" | "tool" | "agent_inference";

export type CaseFactGranularity = "major" | "minor" | "patch" | "full";

export type CaseFact = {
  value: string;
  status: CaseFactStatus;
  source: CaseFactSource;
  subject: string;
  confirmedAt?: string | undefined;
  granularity?: CaseFactGranularity | undefined;
  lastChangedAt?: string | undefined;
  invalidatedAt?: string | undefined;
  history?:
    | Array<{
        value: string;
        source: CaseFactSource;
        status: CaseFactStatus;
        at: string;
      }>
    | undefined;
  dependsOn?: string[] | undefined;
};

export type CaseFacts = Record<string, CaseFact>;

export type AskedFieldRecord = {
  field: string;
  subject: string;
  reason: string;
  askedAt: string;
  factValueAtAsk: string | null;
};

export type ActionRecord = {
  action: string;
  result: "suggested" | "in_progress" | "completed" | "failed" | "rejected";
  subject: string;
  at: string;
};

export type KnowledgeEvidence = {
  chunkId: string;
  knowledgeId: string;
  knowledgeBaseId: string;
  title: string;
  filename: string;
  source: string;
  chunkType: string;
  content: string;
  matchedContent: string;
  score: number;
  startAt: number | null;
  endAt: number | null;
};

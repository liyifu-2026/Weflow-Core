import type { LocationQueryRaw, Router } from "vue-router";

export type NavigationOrigin =
  | {
      type: "conversation";
      conversationId: string;
      messageId?: string;
      evidenceId?: string;
    }
  | {
      type: "strategy";
      policyVersionId: string;
      runId?: string;
      caseId?: string;
    }
  | { type: "standalone" };

export function originQuery(origin?: NavigationOrigin): LocationQueryRaw {
  if (!origin || origin.type === "standalone") return {};
  if (origin.type === "conversation") {
    return {
      origin: "conversation",
      conversationId: origin.conversationId,
      messageId: origin.messageId,
      originEvidenceId: origin.evidenceId,
    };
  }
  return {
    origin: "strategy",
    policyVersionId: origin.policyVersionId,
    runId: origin.runId,
    caseId: origin.caseId,
  };
}

function first(value: unknown): string | undefined {
  return Array.isArray(value)
    ? typeof value[0] === "string"
      ? value[0]
      : undefined
    : typeof value === "string"
      ? value
      : undefined;
}

export function parseOrigin(query: Record<string, unknown>): NavigationOrigin {
  if (first(query.origin) === "conversation" && first(query.conversationId)) {
    return {
      type: "conversation",
      conversationId: first(query.conversationId)!,
      messageId: first(query.messageId),
      evidenceId: first(query.originEvidenceId),
    };
  }
  if (first(query.origin) === "strategy" && first(query.policyVersionId)) {
    return {
      type: "strategy",
      policyVersionId: first(query.policyVersionId)!,
      runId: first(query.runId),
      caseId: first(query.caseId),
    };
  }
  return { type: "standalone" };
}

export function knowledgeTarget(
  origin: NavigationOrigin,
  target: {
    knowledgeBaseId?: string;
    documentId?: string;
    chunkId?: string;
    evidenceId?: string;
    question?: string;
  },
) {
  return {
    path: "/knowledge",
    query: {
      mode: "content",
      ...originQuery(origin),
      knowledgeBaseId: target.knowledgeBaseId,
      documentId: target.documentId,
      chunkId: target.chunkId ?? target.evidenceId,
      evidenceId: target.evidenceId,
    },
  };
}

export async function returnToOrigin(
  _router: Router,
  _origin: NavigationOrigin,
) {
  // 知识页已从 Console 剥离，不再需要跨应用返回跳转。
}

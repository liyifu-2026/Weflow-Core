import type { LocationQueryRaw, Router } from "vue-router";

export type NavigationOrigin =
  | {
      type: "conversation";
      conversationId: string;
      messageId?: string;
      evidenceId?: string;
    }
  | { type: "standalone" };

export function originQuery(origin?: NavigationOrigin): LocationQueryRaw {
  if (!origin || origin.type === "standalone") return {};
  return {
    origin: "conversation",
    conversationId: origin.conversationId,
    messageId: origin.messageId,
    originEvidenceId: origin.evidenceId,
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
    path: "/support/knowledge",
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

export async function returnToOrigin(router: Router, origin: NavigationOrigin) {
  if (origin.type === "conversation") {
    await router.push({
      path: "/support/conversations",
      query: {
        id: origin.conversationId,
        messageId: origin.messageId,
        evidenceId: origin.evidenceId,
      },
    });
  }
}


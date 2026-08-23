/**
 * Customer Support console extension API adapter.
 *
 * Business UI calls the platform Core APIs directly (same-origin proxy in
 * dev/production). This keeps the business frontend thin and lets Core own
 * conversation/handoff/memory facts.
 */
import { api } from "../api";

// ---------- conversation list ----------

export type ConversationContact = {
  contactId: string;
  channelContactId: string | null;
  channelDisplayName: string | null;
  channelNickname: string | null;
  channelRemark: string | null;
  avatarUrl: string | null;
  sharedAlias: string | null;
  note: string | null;
  tags: string[] | null;
};

export type ConversationHandoff = {
  status: string | null;
  reason: string | null;
  createdAt: string | null;
  assignedUserId: string | null;
  assignedQueueId: string | null;
  assignedUser: { username: string } | null;
  agentPaused: boolean;
};

export type ConversationPermissions = {
  canView: boolean;
  canManualTakeover: boolean;
  canReply: boolean;
  canTransfer: boolean;
  canFinish: boolean;
};

export type ConversationListItem = {
  conversationId: string;
  channel: string;
  channelConversationId: string | null;
  latestMessageAt: string | null;
  latestMessage: { text: string | null; actorType: string | null } | null;
  contact: ConversationContact;
  handoff: ConversationHandoff | null;
  riskLevel: string | null;
  unreadCustomerCount: number;
  permissions: ConversationPermissions;
};

export type ConversationListResponse = {
  conversations: ConversationListItem[];
  nextCursor?: string | null;
};

export type ConversationScope = "attention" | "mine" | "others" | "all";

export function listConversations(params: {
  scope: ConversationScope;
  limit?: number;
  before?: string;
}): Promise<ConversationListResponse> {
  const query = new URLSearchParams({
    scope: params.scope,
    limit: String(params.limit ?? 50),
  });
  if (params.before) query.set("before", params.before);
  return api<ConversationListResponse>(`/api/v1/conversations?${query}`);
}

// ---------- transcript ----------

export type TranscriptMessage = {
  messageId: string;
  direction: "inbound" | "outbound";
  actorType: string | null;
  actorId: string | null;
  contentType: string | null;
  mediaId: string | null;
  mediaDescription: string | null;
  text: string | null;
  processingState: string | null;
  sendState: string | null;
  occurredAt: string;
};

export type TranscriptResponse = {
  messages: TranscriptMessage[];
  conversationRevision: number;
  nextCursor: string | null;
};

export function getTranscript(
  conversationId: string,
  params: { limit?: number; before?: string } = {},
): Promise<TranscriptResponse> {
  const query = new URLSearchParams({
    limit: String(params.limit ?? 50),
  });
  if (params.before) query.set("before", params.before);
  return api<TranscriptResponse>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
  );
}

export function sendManualReply(
  conversationId: string,
  input: {
    text: string;
    clientRequestId: string;
    expectedConversationRevision?: number;
  },
): Promise<{ message: TranscriptMessage; replayed: boolean }> {
  return api<{ message: TranscriptMessage; replayed: boolean }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

// ---------- contact profile ----------

export type ContactProfile = {
  contactId: string;
  channelContactId: string | null;
  channelDisplayName: string | null;
  channelNickname: string | null;
  channelRemark: string | null;
  sharedAlias: string | null;
  note: string | null;
  tags: string[] | null;
  agentEnabled: boolean | null;
};

export function getContactProfile(
  conversationId: string,
): Promise<{ profile: ContactProfile }> {
  return api<{ profile: ContactProfile }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/contact-profile`,
  );
}

// ---------- handoff ----------

export type HandoffBriefing =
  | {
      version: 1;
      problemSummary: string;
      confirmedFacts: Array<{ key: string; label: string; value: string }>;
      missingInformation: Array<{ key: string; label: string }>;
      unresolvedItems: string[];
      suggestedFirstReply: string;
      sourceCaseRevision: number;
      generatedAt: string;
    }
  | {
      version: 2;
      problemSummary: string;
      confirmedFacts: Array<{ key: string; label: string; value: string }>;
      triedSteps: string[];
      missingInformation: Array<{ key: string; label: string }>;
      unresolvedItems: string[];
      handoffReason: string;
      suggestedNextStep: string;
      suggestedFirstReply: string;
      sourceConversationRevision: number;
      generatedAt: string;
    };

export type MobileHandoffState = {
  conversationId: string;
  cycleId: string;
  handoffRevision: number;
  status: "HANDOFF_PENDING" | "TRANSFER_PENDING" | "HUMAN_ACTIVE" | "HUMAN_FINISHED";
  assignedUserId: string | null;
  assignedQueueId: string | null;
  targetUserId: string | null;
  targetQueueId: string | null;
  ownerDisplayName: string | null;
  targetDisplayName: string | null;
  canClaim: boolean;
  canRejectTransfer: boolean;
  createdAt: string;
  acceptedAt: string | null;
  transferredAt: string | null;
  pendingSince: string | null;
  acceptBy: string | null;
  fallbackQueueId: string | null;
  finishedAt: string | null;
  resolvedAt: string | null;
};

export type HandoffDetail = {
  state: MobileHandoffState;
  briefing: HandoffBriefing | null;
  activeTransferNote: string | null;
};

export type HandoffDetailResponse = {
  handoff: HandoffDetail | { state: unknown; briefing: unknown; cycles?: unknown; events?: unknown };
};

export function getHandoffDetail(
  conversationId: string,
): Promise<HandoffDetailResponse> {
  return api<HandoffDetailResponse>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff`,
  );
}

export type HandoffAssignee = {
  userId: string;
  displayName: string;
  username: string;
  canReceiveHandoff: boolean;
};

export type HandoffQueue = {
  queueId: string;
  displayName: string;
  shortDescription: string | null;
  canReceiveHandoff: boolean;
};

export function listHandoffAssignees(): Promise<{ users: HandoffAssignee[] }> {
  return api<{ users: HandoffAssignee[] }>("/api/v1/handoff-assignees");
}

export function listHandoffQueues(): Promise<{ queues: HandoffQueue[] }> {
  return api<{ queues: HandoffQueue[] }>("/api/v1/handoff-targets/queues");
}

export function takeOverHandoff(
  conversationId: string,
  input: {
    clientRequestId: string;
    summary?: string;
    sourceConversationRevision?: number;
  },
): Promise<{ handoff: unknown; replayed: boolean }> {
  return api<{ handoff: unknown; replayed: boolean }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/take-over`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function acceptHandoff(
  conversationId: string,
  input: { clientRequestId: string; expectedHandoffRevision?: number; summary?: string },
): Promise<{ handoff: unknown; replayed: boolean }> {
  const body = input.expectedHandoffRevision
    ? {
        clientRequestId: input.clientRequestId,
        expectedHandoffRevision: input.expectedHandoffRevision,
      }
    : {
        clientRequestId: input.clientRequestId,
        summary: input.summary ?? "接手处理",
      };
  return api<{ handoff: unknown; replayed: boolean }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/accept`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export function releaseHandoff(
  conversationId: string,
  input: { summary: string; clientRequestId: string },
): Promise<{ handoff: unknown; replayed: boolean }> {
  return api<{ handoff: unknown; replayed: boolean }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/release`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function resolveHandoff(
  conversationId: string,
  input: { summary: string; clientRequestId: string },
): Promise<{ handoff: unknown; replayed: boolean }> {
  return api<{ handoff: unknown; replayed: boolean }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/resolve`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function finishHandoff(
  conversationId: string,
  input: {
    expectedHandoffRevision: number;
    clientRequestId: string;
    result?: string;
  },
): Promise<{ handoff: unknown; replayed: boolean }> {
  return api<{ handoff: unknown; replayed: boolean }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/finish`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function transferHandoff(
  conversationId: string,
  input:
    | {
        targetType: "user" | "queue";
        targetId: string;
        transferReason?: string;
        sourceConversationRevision: number;
        expectedHandoffRevision: number;
        clientRequestId: string;
      }
    | {
        targetUserId: string;
        summary: string;
        clientRequestId: string;
      },
): Promise<{ handoff: unknown; replayed: boolean }> {
  return api<{ handoff: unknown; replayed: boolean }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/transfer`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function rejectTransfer(
  conversationId: string,
  input: { expectedHandoffRevision: number; clientRequestId: string },
): Promise<{ handoff: unknown; replayed: boolean }> {
  return api<{ handoff: unknown; replayed: boolean }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/reject-transfer`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

// ---------- memory ----------

export type Memory = {
  memoryId: string;
  contactId: string;
  kind: "fact" | "preference" | "relationship";
  memoryKey: string;
  content: string;
  status: "candidate" | "active" | "superseded" | "invalidated";
  confidence: number;
  importance?: number;
  evidenceMessageIds: string[];
  extractedByModel: string;
  validFrom: string;
  invalidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function listMemories(
  conversationId: string,
  status: "candidate" | "active" | "superseded" | "invalidated" | "all" = "all",
): Promise<{ memories: Memory[] }> {
  return api<{ memories: Memory[] }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/memories?status=${status}`,
  );
}

export function createMemory(
  conversationId: string,
  input: {
    kind: Memory["kind"];
    key: string;
    content: string;
    importance?: number;
    clientRequestId: string;
  },
): Promise<{ memory: Memory; replayed: boolean }> {
  return api<{ memory: Memory; replayed: boolean }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/memories`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function transitionMemory(
  conversationId: string,
  memoryId: string,
  action: "activate" | "invalidate",
  clientRequestId: string,
): Promise<{ memory: Memory; replayed: boolean }> {
  return api<{ memory: Memory; replayed: boolean }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/memories/${encodeURIComponent(memoryId)}/actions`,
    {
      method: "POST",
      body: JSON.stringify({ action, clientRequestId }),
    },
  );
}

// ---------- knowledge evidence ----------

export type ConversationEvidence = {
  evidenceId: string;
  documentId: string;
  knowledgeBaseId: string;
  title: string;
  sourceName: string;
  excerpt: string;
  locator?: string;
  provenance: "human_selected" | "agent_retrieval";
  addedBy?: string;
  addedAt?: string;
  retrievedAt?: string;
};

export function getEvidenceTray(
  conversationId: string,
): Promise<{ conversationId: string; evidence: ConversationEvidence[] }> {
  return api<{ conversationId: string; evidence: ConversationEvidence[] }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/knowledge/evidence-tray`,
  );
}

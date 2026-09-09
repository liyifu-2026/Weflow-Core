/** Core-owned Mobile Handoff contract. Mobile never derives ownership. */

export type HandoffStatus =
  | "HANDOFF_PENDING"
  | "TRANSFER_PENDING"
  | "HUMAN_ACTIVE"
  | "HUMAN_FINISHED";

export type HandoffTarget =
  | { type: "user"; id: string; displayName: string }
  | { type: "queue"; id: string; displayName: string };

export type HumanResult =
  | "resolved_by_human"
  | "answered_question"
  | "information_collected"
  | "customer_no_response"
  | "other";

export type HandoffCycleResult = HumanResult | "transferred";

export type HandoffState = {
  conversationId: string;
  cycleId: string;
  handoffRevision: number;
  status: HandoffStatus;
  assignedUserId: string | null;
  assignedQueueId: string | null;
  targetUserId?: string | null;
  targetQueueId?: string | null;
  ownerDisplayName?: string | null;
  targetDisplayName?: string | null;
  canClaim?: boolean;
  canRejectTransfer?: boolean;
  createdAt: string;
  acceptedAt: string | null;
  transferredAt?: string | null;
  pendingSince?: string | null;
  acceptBy?: string | null;
  fallbackQueueId?: string | null;
  finishedAt?: string | null;
  resolvedAt: string | null;
};

export type HandoffCycle = HandoffState & {
  reason: string;
  result?: HandoffCycleResult | null;
  resolution: string | null;
  resolutionSummary?: ResolutionSummary | null;
  transferredByUserId?: string | null;
  target?: HandoffTarget | null;
  /** 转交时的结构化上下文快照（含 transferReason 留言） */
  transferContext?: StructuredTransferContext | null;
};

export type ResolutionSummary = {
  text: string;
  generatedAt: string;
  sourceConversationRevision: number;
  generationMethod: "server_rules_v1";
};

export type HandoffBriefing = {
  briefVersion: number;
  problemSummary: string;
  confirmedFacts: { key: string; label: string; value: string }[];
  triedSteps: string[];
  missingInformation: { key: string; label: string }[];
  unresolvedItems: string[];
  handoffReason: string;
  suggestedNextStep: string;
  suggestedFirstReply: string;
  sourceConversationRevision: number;
  generatedAt: string;
};

export type StructuredTransferContext = HandoffBriefing & {
  sourceCycleId: string;
  transferReason: string;
  transferredByUserId: string;
  targetType: HandoffTarget["type"];
  targetId: string;
};

export type HandoffDetail = {
  state: HandoffState;
  cycles: HandoffCycle[];
  briefing: HandoffBriefing | null;
  /** 当前 cycle 的转交说明（转交给当前负责人的留言），无则 null */
  activeTransferNote: string | null;
};

export type HandoffAssignee = {
  userId: string;
  displayName: string;
  /** 客服头像相对路径（Core 返回；缺失回退首字母） */
  avatarUrl?: string | null;
  specialtyLabel?: string | null;
  availability?: "available" | "busy" | "offline";
  canReceiveHandoff: boolean;
};

export type SpecialistQueueTarget = {
  queueId: string;
  displayName: string;
  shortDescription?: string | null;
  canReceiveHandoff: boolean;
};

export type TransferPreview = {
  context: StructuredTransferContext;
  handoffRevision: number;
};

export type FinishContext = {
  inferredResult: HumanResult | null;
  confidence: number | null;
  requiresConfirmation: boolean;
};

export type HandoffOperation =
  | "claim_handoff"
  | "reject_transfer"
  | "transfer_handoff"
  | "finish_handoff"
  | "take_over";

export type OperationOutcome<T> = {
  status: "pending" | "succeeded" | "failed" | "not_found";
  result?: T;
  errorCode?: string;
};

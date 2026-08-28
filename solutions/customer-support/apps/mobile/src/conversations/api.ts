/**
 * 会话 API 模块
 * 封装与 Core 会话相关的所有 HTTP 请求，包括：
 * - 会话列表和聊天记录查询
 * - 人工接管（handoff）的接手、转交、结束等操作
 * - 联系人资料的读取和更新
 * - 手动回复的发送和结果查询
 * - 已读状态标记
 */
import { request } from "@/api/client";
import type { MobileSession } from "@/auth/session";
import type { MobileCapabilities } from "@/api/capabilities";
import { getMobileCapabilities } from "@/api/capabilities";
import type {
  FinishContext,
  HandoffAssignee,
  HandoffDetail,
  HandoffOperation,
  HandoffState,
  HandoffStatus,
  HumanResult,
  OperationOutcome,
  SpecialistQueueTarget,
  TransferPreview,
} from "@/handoffs/model";
import type { ConversationPreview, WorkState } from "./model";
import { contactDisplayName as sharedContactDisplayName } from "./contact-profile";

export type {
  FinishContext,
  HandoffAssignee,
  HandoffBriefing,
  HandoffCycle,
  HandoffDetail,
  HandoffState,
  HumanResult,
  SpecialistQueueTarget,
  TransferPreview,
} from "@/handoffs/model";

/** Core 返回的会话原始数据结构 */
type ServerConversation = {
  conversationId: string;
  channel?: string;
  latestMessageAt?: string;
  contact?: {
    contactId?: string;
    channelContactId?: string;
    channelDisplayName?: string | null;
    channelNickname?: string | null;
    channelRemark?: string | null;
    companyName?: string | null;
    avatarUrl?: string | null;
    sharedAlias?: string | null;
    note?: string | null;
    tags?: string[];
  };
  latestMessage?: { text?: string };
  handoff?: {
    status?: string;
    handoffRevision?: number;
    assignedUserId?: string | null;
    assignedQueueId?: string | null;
    targetUserId?: string | null;
    targetQueueId?: string | null;
    pendingSince?: string | null;
    problemSummary?: string | null;
    productLabel?: string | null;
    handoffReason?: string | null;
    attentionReason?: string | null;
    canClaim?: boolean;
    assignedUser?: { username?: string } | null;
    targetUser?: { username?: string } | null;
    assignedQueue?: { displayName?: string } | null;
    targetQueue?: { displayName?: string } | null;
  } | null;
  unreadCustomerCount?: number;
};

type MobileHandoffInboxResponse = {
  items: ServerConversation[];
};

/** Core 返回的消息数据结构 */
export type ServerMessage = {
  messageId: string;
  actorType: string;
  actorId?: string | null;
  /** AI 员工头像（平台 DiceBear 代理 URL）；人工/客户消息为 null */
  actorAvatarUrl?: string | null;
  direction: string;
  contentType: string;
  mediaId?: string | null;
  text: string;
  sendState?: string | null;
  sendErrorCode?: string | null;
  occurredAt: string;
  replyToChannelMessageId?: string | null;
  mentionContactRefs?: string[] | null;
};

/** 手动回复的执行结果查询响应 */
export type ManualReplyOutcome = {
  status: "pending" | "accepted" | "sent" | "failed" | "not_found";
  message?: ServerMessage;
};

/** 聊天记录分页响应 */
export type TranscriptPage = {
  messages: ServerMessage[];
  nextCursor: string | null;
  conversationRevision?: number;
  /** Present only when restored from the encrypted offline cache. */
  cachedHandoff?: HandoffDetail;
};

/** 人工接管当前状态 */
/** 联系人资料数据结构 */
export type ContactProfile = {
  contactId: string;
  channel: string;
  channelContactId: string;
  channelDisplayName: string | null;
  channelNickname: string | null;
  channelRemark: string | null;
  channelAlias: string | null;
  avatarUrl: string | null;
  sharedAlias: string | null;
  aliasUpdatedByUserId: string | null;
  aliasUpdatedAt: string | null;
  note: string | null;
  tags: string[];
  agentEnabled: boolean;
  /** 黑名单：true = 不建 Turn、不出现在会话列表、不推通知 */
  blocked: boolean;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type WireHandoffState = Omit<HandoffState, "status"> & { status: string };
type WireHandoffDetail = Omit<HandoffDetail, "state" | "cycles"> & {
  state: WireHandoffState;
  cycles: (Omit<HandoffDetail["cycles"][number], "status"> & {
    status: string;
  })[];
};
type HandoffResponse = { handoff: WireHandoffDetail };

/**
 * The dedicated endpoint is scoped and business-sorted by Core. When the
 * capability is absent Mobile returns no work rather than filtering ordinary
 * conversations into a synthetic Inbox.
 */
export async function listMobileHandoffInbox(
  session: MobileSession,
): Promise<{
  conversations: ConversationPreview[];
  capabilities: MobileCapabilities;
}> {
  const capabilities = await getMobileCapabilities(session);
  if (!capabilities.mobileHandoffInbox) {
    return {
      capabilities,
      conversations: [],
    };
  }
  const result = await request<MobileHandoffInboxResponse>(
    "/api/v1/mobile/handoffs/inbox?limit=50",
    { token: session.sessionToken },
  );
  return {
    capabilities,
    conversations: result.items.map((item) =>
      normalizeConversation(item, session.user.userId),
    ),
  };
}

/** GET /api/v1/conversations 列表项（mobile 可接管列表复用，Bearer 认证） */
type TakeoverableConversationWire = {
  conversationId: string;
  latestMessageAt?: string;
  latestMessage?: { text?: string };
  contact?: {
    contactId?: string | null;
    sharedAlias?: string | null;
    channelDisplayName?: string | null;
    channelRemark?: string | null;
    channelNickname?: string | null;
    channelContactId?: string | null;
  };
  handoff: {
    status: string;
    agentPaused: boolean;
    assignedUserId: string | null;
    targetUserId?: string | null;
    reason?: string | null;
  } | null;
  unreadCustomerCount?: number;
};

/**
 * 可主动接管的 Agent 处理中会话（AGENT_ACTIVE）。
 * 复用 Core `scope=others`（Bearer 可用），只保留无 handoff 行的活跃会话；
 * resolved / 他人处理中 / pending 均不进入此列表。所有权裁决始终在服务端。
 */
export async function listTakeoverableConversations(
  session: MobileSession,
): Promise<ConversationPreview[]> {
  const result = await request<{ conversations: TakeoverableConversationWire[] }>(
    "/api/v1/conversations?scope=others&limit=50",
    { token: session.sessionToken },
  );
  return (result.conversations ?? [])
    .filter((item) => item.handoff === null)
    .map(normalizeTakeoverableConversation);
}

function normalizeTakeoverableConversation(
  item: TakeoverableConversationWire,
): ConversationPreview {
  const name =
    sharedContactDisplayName(item.contact ?? {}) === "客户" &&
    !item.contact?.channelContactId
      ? shortConversationName(item.conversationId)
      : sharedContactDisplayName(item.contact ?? {});
  return {
    id: item.conversationId,
    name,
    company: "",
    preview: item.latestMessage?.text?.trim() || "Agent 正在自动处理",
    time: relativeTime(item.latestMessageAt),
    latestMessageAt: item.latestMessageAt,
    state: "agent",
    contactId: item.contact?.contactId ?? null,
    unread:
      typeof item.unreadCustomerCount === "number"
        ? item.unreadCustomerCount
        : Number(item.unreadCustomerCount ?? 0) || 0,
  };
}

/**
 * 人工主动接管 AGENT_ACTIVE 会话（Manual Takeover）。
 * 服务端原子执行（transition manual_taken_over）：成功即 HUMAN_ACTIVE + 我为负责人。
 * 幂等：同一 clientRequestId 重放返回 replayed=true，可安全重试。
 * 成功后由调用方重新拉取 getHandoff 获取权威状态。
 */
export async function takeOverHandoff(
  session: MobileSession,
  conversationId: string,
  clientRequestId: string,
): Promise<{ replayed: boolean }> {
  const result = await request<{ replayed: boolean }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/take-over`,
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify({ clientRequestId }),
    },
  );
  return { replayed: result.replayed };
}

/** 获取聊天记录，支持通过 cursor 分页加载更早的消息 */
export async function getTranscript(
  session: MobileSession,
  conversationId: string,
  cursor?: string,
): Promise<TranscriptPage> {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("before", cursor);
  return request<TranscriptPage>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?${query.toString()}`,
    { token: session.sessionToken },
  );
}

/** 标记会话为已读 */
export async function markConversationRead(
  session: MobileSession,
  conversationId: string,
  lastReadMessageId: string,
): Promise<void> {
  await request(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/read`,
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify({ lastReadMessageId }),
    },
  );
}

/** 获取会话的人工接管详情，404 时返回 undefined 表示无人工接管 */
export async function getHandoff(
  session: MobileSession,
  conversationId: string,
): Promise<HandoffDetail | undefined> {
  try {
    const result = await request<HandoffResponse>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff`,
      { token: session.sessionToken },
    );
    return normalizeHandoffDetail(result.handoff);
  } catch (reason) {
    if (
      reason instanceof Error &&
      "status" in reason &&
      reason.status === 404
    ) {
      return undefined;
    }
    throw reason;
  }
}

/** 获取联系人资料 */
export async function getContactProfile(
  session: MobileSession,
  conversationId: string,
): Promise<ContactProfile> {
  const result = await request<{ profile: ContactProfile }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/contact-profile`,
    { token: session.sessionToken },
  );
  return result.profile;
}

/** 联系人历史会话摘要（按联系人聚合，供联系人 Sheet 展示） */
export type ContactConversationSummary = {
  conversationId: string;
  latestMessageAt: string | null;
  latestMessageText: string;
  handoffStatus: string | null;
};

/** 联系人历史分页结果 */
export type ContactHistoryPage = {
  conversations: ContactConversationSummary[];
  nextCursor: string | null;
};

/**
 * 查询某联系人的全部历史会话（游标分页，contactId 是事实来源；
 * 无论是否产生过 Handoff、是否已结束都返回）
 */
export async function listContactHistory(
  session: MobileSession,
  contactId: string,
  before?: string,
  limit = 10,
): Promise<ContactHistoryPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  const result = await request<{
    conversations: {
      conversationId: string;
      latestMessageAt: string | null;
      latestMessageText: string;
      handoffStatus: string | null;
    }[];
    nextCursor: string | null;
  }>(
    `/api/v1/contacts/${encodeURIComponent(contactId)}/conversations?${query.toString()}`,
    { token: session.sessionToken },
  );
  return {
    conversations: result.conversations,
    nextCursor: result.nextCursor,
  };
}

/** 更新联系人资料（昵称、备注、标签等） */
export async function updateContactProfile(
  session: MobileSession,
  conversationId: string,
  patch: { note?: string | null; tags?: string[]; sharedAlias?: string | null },
): Promise<ContactProfile> {
  const result = await request<{ profile: ContactProfile }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/contact-profile`,
    {
      method: "PATCH",
      token: session.sessionToken,
      body: JSON.stringify(patch),
    },
  );
  return result.profile;
}

/** 原子接手待处理的人工接管 */
export async function acceptHandoff(
  session: MobileSession,
  conversationId: string,
  clientRequestId: string,
  expectedHandoffRevision?: number,
): Promise<HandoffState> {
  const result = await request<{ handoff: WireHandoffState }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/accept`,
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify({
        clientRequestId,
        expectedHandoffRevision,
      }),
    },
  );
  return normalizeHandoffState(result.handoff);
}

export async function getFinishContext(
  session: MobileSession,
  conversationId: string,
): Promise<FinishContext> {
  return request<FinishContext>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/finish-context`,
    { token: session.sessionToken },
  );
}

export async function finishHandoff(
  session: MobileSession,
  conversationId: string,
  input: {
    expectedHandoffRevision: number;
    clientRequestId: string;
    result?: HumanResult;
  },
): Promise<HandoffState> {
  const result = await request<{ handoff: WireHandoffState }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/finish`,
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify(input),
    },
  );
  return normalizeHandoffState(result.handoff);
}

/** 获取可接收转接的客服人员列表 */
export async function listHandoffAssignees(
  session: MobileSession,
): Promise<HandoffAssignee[]> {
  const result = await request<{
    users: (Partial<HandoffAssignee> & { userId: string; username?: string })[];
  }>(
    "/api/v1/handoff-assignees",
    { token: session.sessionToken },
  );
  return result.users
    .map((user) => ({
      userId: user.userId,
      displayName: user.displayName ?? user.username ?? "客服",
      avatarUrl: user.avatarUrl ?? null,
      specialtyLabel: user.specialtyLabel,
      availability: user.availability,
      canReceiveHandoff: user.canReceiveHandoff ?? true,
    }))
    .filter((user) => user.canReceiveHandoff);
}

export async function listSpecialistQueueTargets(
  session: MobileSession,
): Promise<SpecialistQueueTarget[]> {
  const result = await request<{ queues: SpecialistQueueTarget[] }>(
    "/api/v1/handoff-targets/queues",
    { token: session.sessionToken },
  );
  return result.queues.filter((queue) => queue.canReceiveHandoff);
}

export async function getTransferPreview(
  session: MobileSession,
  conversationId: string,
  input: { targetType: "user" | "queue"; targetId: string },
): Promise<TransferPreview> {
  const preview = await request<
    TransferPreview & {
      context: TransferPreview["context"] & { version?: number };
    }
  >(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/transfer-preview`,
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify(input),
    },
  );
  return {
    ...preview,
    context: {
      ...preview.context,
      briefVersion:
        preview.context.briefVersion ?? preview.context.version ?? 2,
    },
  };
}

export async function transferHandoffV2(
  session: MobileSession,
  conversationId: string,
  input: {
    targetType: "user" | "queue";
    targetId: string;
    transferReason?: string;
    sourceConversationRevision: number;
    expectedHandoffRevision: number;
    clientRequestId: string;
  },
): Promise<HandoffState> {
  const result = await request<{ handoff: WireHandoffState }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/transfer`,
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify(input),
    },
  );
  return normalizeHandoffState(result.handoff);
}

export async function rejectTransfer(
  session: MobileSession,
  conversationId: string,
  input: { expectedHandoffRevision: number; clientRequestId: string },
): Promise<HandoffState> {
  const result = await request<{ handoff: WireHandoffState }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/reject-transfer`,
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify(input),
    },
  );
  return normalizeHandoffState(result.handoff);
}

export async function getHandoffOperationOutcome(
  session: MobileSession,
  operation: HandoffOperation,
  clientRequestId: string,
): Promise<OperationOutcome<HandoffState>> {
  const query = new URLSearchParams({ operation, clientRequestId });
  const outcome = await request<OperationOutcome<WireHandoffState>>(
    `/api/v1/mobile/request-outcomes?${query.toString()}`,
    { token: session.sessionToken },
  );
  return {
    ...outcome,
    result: outcome.result ? normalizeHandoffState(outcome.result) : undefined,
  };
}

/** 发送手动回复消息给客户，支持可选的媒体文件和引用回复 */
export async function sendManualReply(
  session: MobileSession,
  conversationId: string,
  text: string,
  clientRequestId: string,
  expectedConversationRevision?: number,
  options?: {
    mediaId?: string;
    media?: { fileId: string; kind: "image" | "file" | "voice" };
    replyToChannelMessageId?: string;
  },
): Promise<ServerMessage> {
  const body: Record<string, unknown> = {
    text,
    clientRequestId,
    expectedConversationRevision,
  };
  if (options?.mediaId) body.mediaId = options.mediaId;
  if (options?.media) body.media = options.media;
  if (options?.replyToChannelMessageId)
    body.replyToChannelMessageId = options.replyToChannelMessageId;
  const result = await request<{ message: ServerMessage }>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify(body),
    },
  );
  return result.message;
}

/** 查询手动回复的执行结果（用于处理发送结果未知的情况） */
export async function getManualReplyOutcome(
  session: MobileSession,
  conversationId: string,
  clientRequestId: string,
): Promise<ManualReplyOutcome> {
  return request<ManualReplyOutcome>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/outcome?clientRequestId=${encodeURIComponent(clientRequestId)}`,
    { token: session.sessionToken },
  );
}

/** 将 Core 返回的原始会话数据转换为客户端预览格式 */
function normalizeConversation(
  item: ServerConversation,
  currentUserId: string,
): ConversationPreview {
  const handoffStatus = item.handoff?.status;
  const state: WorkState =
    (handoffStatus === "TRANSFER_PENDING" ||
      handoffStatus === "transfer_pending") &&
    item.handoff?.targetUserId === currentUserId
      ? "transfer_target"
      : handoffStatus === "HANDOFF_PENDING" || handoffStatus === "pending"
      ? "pending"
      : handoffStatus === "HUMAN_ACTIVE" || handoffStatus === "in_progress"
        ? item.handoff?.assignedUserId === currentUserId
          ? "mine"
          : "other"
        : handoffStatus === "HUMAN_FINISHED" ||
            handoffStatus === "finished" ||
            handoffStatus === "resolved"
          ? "resolved"
          : "agent";
  return {
    id: item.conversationId,
    name: contactName(item),
    company:
      item.contact?.companyName?.trim() ||
      item.handoff?.productLabel?.trim() ||
      "",
    preview:
      item.handoff?.problemSummary?.trim() ||
      item.latestMessage?.text ||
      "打开会话查看问题",
    time: relativeTime(
      state === "pending" || state === "transfer_target"
        ? item.handoff?.pendingSince ?? item.latestMessageAt
        : item.latestMessageAt,
    ),
    latestMessageAt: item.latestMessageAt,
    state,
    contactId: item.contact?.contactId ?? null,
    avatarUrl: item.contact?.avatarUrl ?? null,
    attentionReason:
      item.handoff?.attentionReason?.trim() ||
      item.handoff?.handoffReason?.trim() ||
      undefined,
    handoffReason: item.handoff?.handoffReason?.trim() || undefined,
    handoffRevision: item.handoff?.handoffRevision,
    pendingSince: item.handoff?.pendingSince,
    targetDisplayName:
      item.handoff?.targetUser?.username ??
      item.handoff?.targetQueue?.displayName ??
      item.handoff?.assignedQueue?.displayName ??
      null,
    owner: item.handoff?.assignedUser?.username,
    assignedQueueId: item.handoff?.assignedQueueId ?? null,
    unread:
      typeof item.unreadCustomerCount === "number"
        ? item.unreadCustomerCount
        : Number(item.unreadCustomerCount ?? 0) || 0,
  };
}

/** Translate Core's canonical state names at the API boundary only. */
function normalizeHandoffStatus(status: string): HandoffStatus {
  switch (status) {
    case "HANDOFF_PENDING":
    case "pending":
      return "HANDOFF_PENDING";
    case "TRANSFER_PENDING":
    case "transfer_pending":
      return "TRANSFER_PENDING";
    case "HUMAN_ACTIVE":
    case "in_progress":
      return "HUMAN_ACTIVE";
    case "HUMAN_FINISHED":
    case "finished":
      return "HUMAN_FINISHED";
    case "resolved":
      return "HUMAN_FINISHED";
    default:
      throw new Error(`Unsupported Handoff status: ${status}`);
  }
}

function normalizeHandoffState(state: WireHandoffState): HandoffState {
  return { ...state, status: normalizeHandoffStatus(state.status) };
}

function normalizeHandoffDetail(detail: WireHandoffDetail): HandoffDetail {
  return {
    ...detail,
    state: normalizeHandoffState(detail.state),
    cycles: detail.cycles.map((cycle) => ({
      ...cycle,
      status: normalizeHandoffStatus(cycle.status),
    })),
    briefing: detail.briefing
      ? {
          ...detail.briefing,
          briefVersion:
            detail.briefing.briefVersion ??
            (detail.briefing as HandoffDetail["briefing"] & {
              version?: number;
            }).version ??
            2,
        }
      : null,
  };
}

/** 联系人显示名走唯一优先链（contact-profile.ts）；无任何资料时用会话短名兜底 */
function contactName(item: ServerConversation): string {
  const display = sharedContactDisplayName(item.contact ?? {});
  return display === "客户" && !item.contact?.channelContactId
    ? shortConversationName(item.conversationId)
    : display;
}

function shortConversationName(conversationId: string): string {
  const value = conversationId.split(":").at(-1) ?? conversationId;
  return `会话 · ${value.slice(-8)}`;
}

/** 将 ISO 时间戳转换为相对时间描述（如"3分钟前"、"2小时前"） */
function relativeTime(value: string | undefined): string {
  if (!value) return "暂无消息";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - date.getTime()) / 60_000),
  );
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}小时前`;
  return `${Math.floor(minutes / 1_440)}天前`;
}

/** 隐藏/恢复会话（用户级可见性；隐藏只影响当前用户） */
export async function setConversationHidden(
  session: MobileSession,
  conversationId: string,
  hidden: boolean,
): Promise<void> {
  await request(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/visibility`,
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify({ hidden }),
    },
  );
}

/** 已隐藏会话列表（恢复入口） */
export async function listHiddenConversations(
  session: MobileSession,
): Promise<{ conversations: ConversationPreview[] }> {
  const result = await request<{
    conversations: Record<string, unknown>[];
  }>("/api/v1/conversations/hidden", { token: session.sessionToken });
  return {
    conversations: (result.conversations ?? []).map((item) =>
      normalizeTakeoverableConversation(
        item as TakeoverableConversationWire,
      ),
    ),
  };
}

/** 全部可见会话（scope=all，游标分页；含未触发人工接管的普通会话） */
export async function listAllConversations(
  session: MobileSession,
  before?: string,
): Promise<{ conversations: ConversationPreview[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: "100", scope: "all" });
  if (before) query.set("before", before);
  const result = await request<{
    conversations: TakeoverableConversationWire[];
    nextCursor?: string | null;
  }>(`/api/v1/conversations?${query.toString()}`, {
    token: session.sessionToken,
  });
  return {
    conversations: (result.conversations ?? []).map((item) =>
      normalizeAllConversation(item, session.user.userId),
    ),
    nextCursor: result.nextCursor ?? null,
  };
}

/** scope=all 会话行 → 预览（状态映射：pending/transfer_pending/in_progress/resolved/null） */
function normalizeAllConversation(
  item: TakeoverableConversationWire,
  currentUserId: string,
): ConversationPreview {
  const status = item.handoff?.status;
  const state: ConversationPreview["state"] =
    status === "transfer_pending"
      ? item.handoff?.targetUserId === currentUserId
        ? "transfer_target"
        : "other"
      : status === "pending"
        ? "pending"
        : status === "in_progress"
          ? item.handoff?.assignedUserId === currentUserId
            ? "mine"
            : "other"
          : status === "resolved"
            ? "resolved"
            : "agent";
  return {
    ...normalizeTakeoverableConversation(item),
    state,
  };
}

/** 联系人通讯录（微信式列表；游标分页） */
export async function listContacts(
  session: MobileSession,
  before?: string,
): Promise<{ contacts: ContactListRow[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: "100" });
  if (before) query.set("before", before);
  const result = await request<{
    contacts: ContactListRow[];
    nextCursor?: string | null;
  }>(`/api/v1/contacts?${query.toString()}`, {
    token: session.sessionToken,
  });
  return {
    contacts: result.contacts ?? [],
    nextCursor: result.nextCursor ?? null,
  };
}

/** 联系人列表行（服务端聚合） */
export type ContactListRow = {
  contactId: string;
  channelDisplayName: string | null;
  channelNickname: string | null;
  channelRemark: string | null;
  sharedAlias: string | null;
  avatarUrl: string | null;
  conversationId: string;
  latestMessageAt: string | null;
  latestMessageText: string;
  /** 联系人白名单：true = 由 Agent 负责 */
  agentEnabled: boolean;
  /** 黑名单：true = 不进会话列表、不建 Turn、不推通知 */
  blocked: boolean;
  /** 首次联系时间 */
  firstContactAt: string | null;
  /** 历史会话总数 */
  conversationCount: number;
  /** 最近一次人工处理人 */
  lastHandlerName: string | null;
  /** 最近一次人工处理时间 */
  lastHandlerAt: string | null;
};

/** 拉黑 / 取消拉黑联系人（写审计；拉黑后该联系人的会话从列表隐藏） */
export async function setContactBlocked(
  session: MobileSession,
  conversationId: string,
  blocked: boolean,
): Promise<void> {
  await request(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/contact-profile`,
    {
      method: "PATCH",
      token: session.sessionToken,
      body: JSON.stringify({ blocked }),
    },
  );
}

/** 联系人显示名（与 contact-sheet 一致：共享别名 > 显示名 > 备注 > 昵称 > ID 尾号） */
/** ContactListRow 版本的显示名：委托统一的优先链实现（contact-profile.ts） */
export function contactDisplayName(row: ContactListRow): string {
  return sharedContactDisplayName({
    sharedAlias: row.sharedAlias,
    channelDisplayName: row.channelDisplayName,
    channelRemark: row.channelRemark,
    channelNickname: row.channelNickname,
    channelContactId: row.contactId,
  });
}

/** 拍一拍：向会话发送拍一拍通知 */
export async function pokeConversation(
  session: MobileSession,
  conversationId: string,
): Promise<void> {
  await request(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/poke`,
    {
      method: "POST",
      token: session.sessionToken,
    },
  );
}

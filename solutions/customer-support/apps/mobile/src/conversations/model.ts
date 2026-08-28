/** Server-backed row model for the dedicated Mobile Handoff Inbox. */
export type WorkState =
  | "pending"
  | "transfer_target"
  | "mine"
  | "other"
  | "agent"
  | "resolved";

export type ConversationPreview = {
  id: string;
  name: string;
  company: string;
  preview: string;
  time: string;
  latestMessageAt?: string;
  state: WorkState;
  /** 客户 contactId（contact:wechat:xxx），用于头像代理端点 */
  contactId?: string | null;
  avatarUrl?: string | null;
  attentionReason?: string;
  handoffReason?: string;
  /** 乐观锁修订号（pending/transfer_target 左滑快速接手时使用） */
  handoffRevision?: number;
  pendingSince?: string | null;
  targetDisplayName?: string | null;
  owner?: string;
  assignedQueueId?: string | null;
  unread?: number;
};

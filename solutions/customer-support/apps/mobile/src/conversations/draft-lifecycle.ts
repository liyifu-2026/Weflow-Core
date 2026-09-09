/**
 * 草稿生命周期模块
 * 汇总会话页的草稿状态决策：加载后的状态推导、发送闸门、
 * 发送失败后的恢复以及转交后的可见性。纯函数，便于页面级测试。
 */
import type { LocalDraft } from "./draft-store";
import { shouldMarkDraftStale } from "./safety";

/** 草稿在当前会话上下文下的视图状态。 */
export type DraftViewState = {
  content: string;
  status: LocalDraft["status"];
  reviewedAtRevision: number | null;
  /** 会话是否仍由当前账号负责（转交后为 false，草稿仅供查看）。 */
  isOwner: boolean;
  canSend: boolean;
};

export function isDraftOwner(
  handoffStatus: string | undefined,
  assignedUserId: string | null | undefined,
  currentUserId: string | undefined,
): boolean {
  return (
    handoffStatus === "HUMAN_ACTIVE" &&
    assignedUserId !== null &&
    assignedUserId !== undefined &&
    assignedUserId === currentUserId
  );
}

/**
 * 加载草稿后的状态：会话版本前进且未确认最新内容时标记 stale，
 * 内容与来源保持不变，等待客服明确检查。
 */
export function restoredDraftStatus(
  savedDraft: LocalDraft,
  currentRevision: number | undefined,
): LocalDraft["status"] {
  if (
    shouldMarkDraftStale(
      savedDraft.baseConversationRevision,
      savedDraft.reviewedAtRevision,
      currentRevision,
    )
  ) {
    return "stale_revision";
  }
  return savedDraft.status;
}

export function restoredDraftForCycle(
  savedDraft: LocalDraft,
  currentCycleId: string,
  currentRevision: number | undefined,
): LocalDraft["status"] {
  if (savedDraft.handoffId !== currentCycleId) return "archived_transfer";
  return restoredDraftStatus(savedDraft, currentRevision);
}

/**
 * 发送闸门：锁定草稿不可发送；stale 草稿必须在完成检查
 * （reviewedAtRevision 追平当前版本）后才能发送。
 */
export function canSendDraft(
  status: LocalDraft["status"] | undefined,
  reviewedAtRevision: number | null | undefined,
  conversationRevision: number | undefined,
): boolean {
  if (status === "locked_reauth" || status === "archived_transfer") return false;
  if (
    status === "stale_revision" &&
    reviewedAtRevision !== conversationRevision
  ) {
    return false;
  }
  return true;
}

/**
 * 发送失败后的草稿恢复载荷：权限丢失时丢弃草稿（账号已失效），
 * 其余失败把原文写回本地草稿，baseConversationRevision 置空，
 * 等待客服按最新会话重新检查。返回 undefined 表示不恢复。
 */
export function restoreDraftAfterSendFailure(
  input: {
    accountId: string;
    conversationId: string;
    handoffId: string;
    content: string;
    source: LocalDraft["source"];
    evidenceId?: string;
    suggestionId?: string;
    sourceRevision?: number;
    evidenceIds?: string[];
    edited?: boolean;
    reviewedAtRevision: number | null;
    failure: string;
  },
): Omit<LocalDraft, "updatedAt"> | undefined {
  if (input.failure === "permission_lost") return undefined;
  return {
    accountId: input.accountId,
    conversationId: input.conversationId,
    handoffId: input.handoffId,
    baseConversationRevision: null,
    reviewedAtRevision: input.reviewedAtRevision,
    content: input.content,
    source: input.source,
    evidenceId: input.evidenceId,
    origin: input.source === "suggested" ? "ai_suggestion" : "manual",
    suggestionId: input.suggestionId,
    sourceRevision: input.sourceRevision,
    evidenceIds: input.evidenceIds,
    edited: input.edited,
    status: "saved_local",
  };
}

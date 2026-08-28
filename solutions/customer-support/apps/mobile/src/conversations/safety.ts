/**
 * 消息发送安全策略模块
 * 判断草稿是否因会话内容更新而过期，以及发送失败后是否允许重试。
 */
export type SendFailureCode =
  | "retryable_failed"
  | "rejected"
  | "permission_lost"
  | "outcome_unknown";

/**
 * 判断草稿是否应标记为过期
 * 当会话版本号前进且用户尚未确认最新内容时，草稿标记为过期
 */
export function shouldMarkDraftStale(
  baseRevision: number | null | undefined,
  reviewedAtRevision: number | null | undefined,
  currentRevision: number | undefined,
): boolean {
  return (
    baseRevision !== null &&
    baseRevision !== undefined &&
    currentRevision !== undefined &&
    baseRevision !== currentRevision &&
    reviewedAtRevision !== currentRevision
  );
}

/** 判断发送失败后是否允许重试：权限丢失和被拒绝不可重试，结果未知需先查询 */
export function mayRetrySend(
  failure: SendFailureCode,
  outcome: "pending" | "accepted" | "sent" | "failed" | "not_found" | undefined,
): boolean {
  if (failure === "permission_lost" || failure === "rejected") return false;
  if (failure === "outcome_unknown") return outcome === "failed" || outcome === "not_found";
  return true;
}

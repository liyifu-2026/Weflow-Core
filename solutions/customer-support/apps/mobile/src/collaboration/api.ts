/**
 * 协作 API 模块
 * 封装专业队列协作相关的 HTTP 请求，包括：
 * - 获取会话的协作请求列表
 * - 领取、回答、关闭和取消协作请求
 */
import { request } from "@/api/client";
import type { MobileSession } from "@/auth/session";

/** 协作类型：普通协助或升级处理 */
export type CollaborationKind = "assist" | "escalation";

/** 协作请求数据结构 */
export type CollaborationRequest = {
  requestId: string;
  conversationId: string;
  handoffId: string;
  kind: CollaborationKind;
  status: "pending" | "claimed" | "answered" | "closed" | "cancelled";
  queueId: string;
  queueName?: string;
  createdByUserId: string;
  claimedByUserId?: string | null;
  reason: string;
  claimSummary?: string;
  resolution?: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 获取会话的所有协作请求（协助 + 升级），按更新时间降序排列 */
export async function listConversationCollaboration(
  session: MobileSession,
  conversationId: string,
): Promise<CollaborationRequest[]> {
  const base = `/api/v1/conversations/${encodeURIComponent(conversationId)}`;
  const [assist, escalation] = await Promise.all([
    request<{ requests: CollaborationRequest[] }>(
      `${base}/assistance-requests`,
      { token: session.sessionToken },
    ),
    request<{ requests: CollaborationRequest[] }>(`${base}/escalations`, {
      token: session.sessionToken,
    }),
  ]);
  return [...assist.requests, ...escalation.requests].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** 领取协作请求 */
export async function claimCollaborationRequest(
  session: MobileSession,
  requestId: string,
  clientRequestId: string,
): Promise<CollaborationRequest> {
  const result = await request<{ request: CollaborationRequest }>(
    `/api/v1/collaboration-requests/${encodeURIComponent(requestId)}/claim`,
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify({ clientRequestId }),
    },
  );
  return result.request;
}

/** 提交协作意见 */
export async function answerCollaborationRequest(
  session: MobileSession,
  requestId: string,
  resolution: string,
): Promise<CollaborationRequest> {
  const result = await request<{ request: CollaborationRequest }>(
    `/api/v1/collaboration-requests/${encodeURIComponent(requestId)}/answer`,
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify({ resolution }),
    },
  );
  return result.request;
}

/** 关闭已回答的协作请求 */
export async function closeCollaborationRequest(
  session: MobileSession,
  requestId: string,
): Promise<CollaborationRequest> {
  const result = await request<{ request: CollaborationRequest }>(
    `/api/v1/collaboration-requests/${encodeURIComponent(requestId)}/close`,
    { method: "POST", token: session.sessionToken },
  );
  return result.request;
}

/** 取消待领取的协作请求（仅发起人、pending 状态可取消） */
export async function cancelCollaborationRequest(
  session: MobileSession,
  requestId: string,
): Promise<CollaborationRequest> {
  const result = await request<{ request: CollaborationRequest }>(
    `/api/v1/collaboration-requests/${encodeURIComponent(requestId)}/cancel`,
    { method: "POST", token: session.sessionToken },
  );
  return result.request;
}

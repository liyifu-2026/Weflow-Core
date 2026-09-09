/**
 * 协作 API 模块
 * 封装专业队列协作相关的 HTTP 请求，包括：
 * - 获取专业队列列表
 * - 创建协助/升级请求
 * - 领取、回答和关闭协作请求
 */
import { request } from "@/api/client";
import type { MobileSession } from "@/auth/session";

/** 专业队列信息 */
export type SpecialistQueue = {
  queueId: string;
  key: string;
  displayName: string;
  description?: string;
  isActive: boolean;
};

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

/** 获取所有活跃的专业队列 */
export async function getSpecialistQueues(
  session: MobileSession,
): Promise<SpecialistQueue[]> {
  const result = await request<{ queues: SpecialistQueue[] }>(
    "/api/v1/specialist-queues",
    { token: session.sessionToken },
  );
  return result.queues.filter((queue) => queue.isActive);
}

/** 创建协作请求（根据类型选择协助或升级接口） */
export async function createCollaborationRequest(
  session: MobileSession,
  input: {
    conversationId: string;
    handoffId: string;
    kind: CollaborationKind;
    queueId: string;
    reason: string;
    clientRequestId: string;
  },
): Promise<CollaborationRequest> {
  const path =
    input.kind === "assist"
      ? `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/assistance-requests`
      : `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/escalations`;
  const result = await request<{ request: CollaborationRequest }>(path, {
    method: "POST",
    token: session.sessionToken,
    body: JSON.stringify({
      handoffId: input.handoffId,
      queueId: input.queueId,
      reason: input.reason,
      clientRequestId: input.clientRequestId,
    }),
  });
  return result.request;
}

/**
 * 会话详情页共享类型：展示用消息与发送失败分类。
 */
import type { ServerMessage } from "@/conversations/api";

/** 展示用消息类型，扩展了客户端请求 ID 用于追踪发送状态 */
export type DisplayMessage = ServerMessage & {
  clientRequestId?: string;
  expectedConversationRevision?: number;
};
/** 发送失败类型 */
export type SendFailure =
  | "retryable_failed"
  | "rejected"
  | "permission_lost"
  | "outcome_unknown"
  | "outcome_pending";


/**
 * 会话类型（chatType）——Channel 事实的单一推导点（ADR-0010）。
 *
 * 协议 v6 起 Host 经 ChannelEvent.conversationKind 上报会话类型，Core
 * ingest 落库为 conversations.chat_type，消费方一律读事实。本模块只服务
 * 两个后缀回退场景：
 * 1. ingest：旧 Host 事件缺 conversationKind 时，按通道约定推导一次
 *    （微信即 conversationRef 以 @chatroom 结尾）；
 * 2. 读取兜底：行缺失/未迁移的极端场景。
 * 除上述两处外，任何代码不得再从 ID 形态推导会话类型——@chatroom 是
 * 通道 wire 细节，不是 Core 领域语言。
 */

export type ChatType = "private" | "group";

/** @deprecated 通道后缀回退推导；仅 ingest 与读取兜底可用（ADR-0010） */
export function chatTypeFromConversationRef(
  conversationRef: string,
): ChatType {
  return conversationRef.endsWith("@chatroom") ? "group" : "private";
}

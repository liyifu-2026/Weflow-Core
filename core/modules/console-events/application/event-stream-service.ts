/**
 * 会话事件流订阅服务（console-events 的 application 层）。
 *
 * 事件总线是 infrastructure 的事件发布器；本服务把「订阅」与「事件标识
 * 推导」收敛为业务能力，SSE 连接管理留在 interface 的 HTTP 适配器里。
 */
import {
  conversationEvents,
  type ConversationEvent,
} from "../../../infrastructure/events/conversation-events.js";

export type { ConversationEvent };

/** 订阅会话事件，返回退订函数 */
export function subscribeConversationEvents(
  send: (event: ConversationEvent) => void,
): () => void {
  return conversationEvents.on(send);
}

/**
 * 事件 id 是给 Last-Event-ID 断线重放预留的稳定标识（重放尚未实现）：
 * 有 messageId 时按消息定位，否则按事件类型 + 会话定位。
 */
export function conversationEventId(event: ConversationEvent): string {
  return event.messageId === undefined
    ? `${event.occurredAt}#${event.type}#${event.conversationId}`
    : `${event.occurredAt}#${event.messageId}`;
}

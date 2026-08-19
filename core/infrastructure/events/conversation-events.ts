/**
 * Conversation 事件总线（进程内）。
 *
 * Console 通过 SSE（GET /api/v1/console/events/stream）订阅这些事件，
 * 收到后只失效对应资源并回拉权威状态——事件不是事实来源。
 *
 * 当前为单实例进程内总线（core 单进程部署）；若未来多实例，
 * 迁移到 Postgres LISTEN/NOTIFY 或消息队列即可，接口不变。
 */
import { EventEmitter } from "node:events";

export type ConversationEventType =
  | "customer_message"
  | "agent_message"
  | "human_message"
  | "handoff_created"
  | "handoff_claimed"
  | "handoff_transferred"
  | "handoff_finished"
  | "ownership_changed"
  | "brief_updated"
  | "conversation_updated";

export type ConversationEvent = {
  type: ConversationEventType;
  conversationId: string;
  occurredAt: string;
  messageId?: string;
};

const emitter = new EventEmitter();
emitter.setMaxListeners(64);

export const conversationEvents = {
  on(listener: (event: ConversationEvent) => void): () => void {
    emitter.on("conversation", listener);
    return () => emitter.off("conversation", listener);
  },
  publish(event: ConversationEvent): void {
    emitter.emit("conversation", event);
  },
};

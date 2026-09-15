/**
 * Conversation 事件总线（跨进程）。
 *
 * Console / 移动端通过 SSE（GET /api/v1/console/events/stream）订阅这些事件，
 * 收到后只失效对应资源并回拉权威状态——事件不是事实来源。
 *
 * 部署形态是 api / agent-worker / ingestion-worker 三进程：仅靠进程内
 * EventEmitter，worker 侧发布的事件（Agent 回复、媒体转写完成）永远到不了
 * api 进程的 SSE 连接。因此 publish 时先本地即时投递，再经 Redis 广播给其他
 * 进程；信封带 origin 标识来源进程，回环副本按 origin 去重，保证每个进程
 * 恰好投递一次。Redis 不可用时降级为进程内投递，客户端重连后仍会全量对账。
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import type { Logger } from "pino";

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
  | "conversation_updated"
  /** 发送期插话闸门：agent 回复分段因客户插话被扣留（剩余分段置 held） */
  | "reply_interrupted";

export type ConversationEvent = {
  type: ConversationEventType;
  conversationId: string;
  occurredAt: string;
  messageId?: string;
};

/** 线上信封：事件 + 来源进程标识（只用于回环去重，不投递给订阅者）。 */
type WireEvent = ConversationEvent & { origin: string };

const CHANNEL = "weflow:conversation-events";

const emitter = new EventEmitter();
emitter.setMaxListeners(64);

/** 本进程实例标识：区分「自己发布的事件」与「其他进程广播的事件」。 */
const processOrigin = randomUUID();

let publisher: Redis | undefined;
let subscriber: Redis | undefined;
let publishLogger: Logger | undefined;

/** 投递给订阅者的事件不带 origin——进程内部标识不外泄给消费端。 */
function deliver(envelope: WireEvent): void {
  emitter.emit("conversation", {
    type: envelope.type,
    conversationId: envelope.conversationId,
    occurredAt: envelope.occurredAt,
    ...(envelope.messageId === undefined
      ? {}
      : { messageId: envelope.messageId }),
  });
}

export type ConversationEventBusInput = {
  redisUrl: string;
  logger: Logger;
  /** 是否订阅其他进程的事件：api 进程需要（SSE 消费端），worker 只发布。 */
  subscribe: boolean;
};

/**
 * 启动跨进程事件总线，返回进程优雅退出时调用的关闭函数。
 * Redis 连接异步建立：暂不可用时事件仍走本地投递，恢复后自动续传。
 */
export function startConversationEventBus(
  input: ConversationEventBusInput,
): () => void {
  publishLogger = input.logger;
  if (!publisher) {
    publisher = new Redis(input.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    publisher.on("error", (error) => {
      input.logger.warn(
        { err: error },
        "conversation event publisher redis error",
      );
    });
    publisher.connect().catch((error: unknown) => {
      input.logger.warn(
        { err: error },
        "conversation event publisher connect failed",
      );
    });
  }
  if (input.subscribe && !subscriber) {
    subscriber = new Redis(input.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    subscriber.on("error", (error) => {
      input.logger.warn(
        { err: error },
        "conversation event subscriber redis error",
      );
    });
    subscriber.on("message", (channel, raw) => {
      if (channel !== CHANNEL) return;
      let envelope: WireEvent;
      try {
        envelope = JSON.parse(raw) as WireEvent;
      } catch {
        input.logger.warn(
          { channel },
          "conversation event payload is not valid JSON",
        );
        return;
      }
      // 本进程发布的事件已在 publish 时本地投递，跳过回环副本。
      if (envelope.origin === processOrigin) return;
      deliver(envelope);
    });
    subscriber.subscribe(CHANNEL).catch((error: unknown) => {
      input.logger.warn({ err: error }, "conversation event subscribe failed");
    });
  }

  return () => {
    subscriber?.disconnect();
    publisher?.disconnect();
    subscriber = undefined;
    publisher = undefined;
  };
}

export const conversationEvents = {
  /** 订阅本进程可见的全部会话事件（本地发布 + 其他进程广播）。 */
  on(listener: (event: ConversationEvent) => void): () => void {
    emitter.on("conversation", listener);
    return () => {
      emitter.off("conversation", listener);
    };
  },
  /** 发布事件：先本地投递，再广播给其他进程（不阻塞调用方）。 */
  publish(event: ConversationEvent): void {
    const envelope: WireEvent = { ...event, origin: processOrigin };
    deliver(envelope);
    void publisher
      ?.publish(CHANNEL, JSON.stringify(envelope))
      .catch((error: unknown) => {
        publishLogger?.warn(
          { err: error },
          "conversation event publish failed",
        );
      });
  },
};

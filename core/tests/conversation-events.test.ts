/**
 * 会话事件总线测试
 *
 * 本地投递不需要 Redis；跨进程投递用两个模块实例模拟 api / worker 进程，
 * 需要 REDIS_URL（未设置时跳过，与集成测试守卫一致）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  conversationEvents,
  startConversationEventBus,
  type ConversationEvent,
} from "../infrastructure/events/conversation-events.js";

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const sampleEvent: ConversationEvent = {
  type: "agent_message",
  conversationId: "channel:event-bus-test",
  messageId: "agent-message:event-bus-test",
  occurredAt: "2026-09-08T00:00:00.000Z",
};

describe("conversation events local delivery", () => {
  it("delivers published events to local subscribers without the process origin", () => {
    const received: ConversationEvent[] = [];
    const unsubscribe = conversationEvents.on((event) => received.push(event));

    conversationEvents.publish(sampleEvent);
    unsubscribe();

    expect(received).toEqual([sampleEvent]);
  });

  it("stops delivering after unsubscribe", () => {
    const received: ConversationEvent[] = [];
    const unsubscribe = conversationEvents.on((event) => received.push(event));
    unsubscribe();

    conversationEvents.publish(sampleEvent);

    expect(received).toEqual([]);
  });
});

const redisUrl = process.env.REDIS_URL;
const integration = redisUrl ? describe : describe.skip;

integration("conversation event bus cross-process delivery", () => {
  const cleanups: Array<() => void> = [];
  const logger = createLogger({ logLevel: "silent" }, "conversation-events");

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    vi.resetModules();
  });

  it("delivers events published by another process instance", async () => {
    vi.resetModules();
    const consumer =
      await import("../infrastructure/events/conversation-events.js");
    vi.resetModules();
    const producer =
      await import("../infrastructure/events/conversation-events.js");
    cleanups.push(
      consumer.startConversationEventBus({
        redisUrl: redisUrl ?? "",
        logger,
        subscribe: true,
      }),
      producer.startConversationEventBus({
        redisUrl: redisUrl ?? "",
        logger,
        subscribe: false,
      }),
    );
    const received: ConversationEvent[] = [];
    cleanups.push(
      consumer.conversationEvents.on((event) => received.push(event)),
    );
    // 断言两个模块实例相互独立：否则消费者可能只是收到了同进程的本地投递，
    // 跨进程链路没有被真正验证。
    expect(producer.conversationEvents).not.toBe(consumer.conversationEvents);

    // 订阅连接是异步建立的：重试发布直到收到（上限 5s）。
    const deadline = Date.now() + 5_000;
    while (received.length === 0 && Date.now() < deadline) {
      producer.conversationEvents.publish(sampleEvent);
      await sleep(100);
    }

    expect(received.length).toBeGreaterThan(0);
    expect(received.at(0)).toEqual(sampleEvent);
  });

  it("does not deliver the redis echo of a locally published event twice", async () => {
    const received: ConversationEvent[] = [];
    cleanups.push(conversationEvents.on((event) => received.push(event)));
    cleanups.push(
      startConversationEventBus({
        redisUrl: redisUrl ?? "",
        logger,
        subscribe: true,
      }),
    );
    // 等订阅就绪后再计数：本机 Redis 毫秒级，1s 覆盖冷启动。
    await sleep(1_000);
    received.length = 0;

    conversationEvents.publish(sampleEvent);
    await sleep(500);

    expect(received).toEqual([sampleEvent]);
  });
});

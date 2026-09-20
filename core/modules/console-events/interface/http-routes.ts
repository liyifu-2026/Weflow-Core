import type { FastifyInstance } from "fastify";
import type { BusinessDb } from "../../identity/application/db.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import {
  conversationEventId,
  subscribeConversationEvents,
} from "../application/event-stream-service.js";

/**
 * Console 会话事件流（SSE）。
 *
 * 鉴权后保持连接，推送会话/handoff 事件；客户端收到事件后只失效
 * 对应资源并回拉 Core 权威状态。心跳 25s 防代理断连。
 */
export function registerConsoleEventRoutes(
  server: FastifyInstance,
  db: BusinessDb,
): void {
  server.get("/api/v1/console/events/stream", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const send = (event: Parameters<typeof conversationEventId>[0]) => {
      reply.raw.write(
        `id: ${conversationEventId(event)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };
    const unsubscribe = subscribeConversationEvents(send);
    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 25_000);

    request.raw.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  });
}

import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import {
  conversationEvents,
  type ConversationEvent,
} from "../../../infrastructure/events/conversation-events.js";

/**
 * Console 会话事件流（SSE）。
 *
 * 鉴权后保持连接，推送会话/handoff 事件；Console 收到事件后只失效
 * 对应资源并回拉 Core 权威状态。心跳 25s 防代理断连。
 */
export function registerConsoleEventRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
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

    const send = (event: ConversationEvent) => {
      reply.raw.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };
    const unsubscribe = conversationEvents.on(send);
    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 25_000);

    request.raw.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  });
}

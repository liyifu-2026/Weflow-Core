/**
 * 记忆模块 HTTP 路由
 *
 * 注册记忆查询、手动创建和状态变更的 REST API 端点。
 * 所有路由均需要业务身份认证，写操作支持幂等性。
 */
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import {
  createManualMemory,
  listConversationMemories,
  transitionMemory,
} from "../application/manage-memories.js";

const paramsSchema = z.object({
  conversationId: z.string().min(1).max(300),
});
const memoryParamsSchema = paramsSchema.extend({
  memoryId: z.string().min(1).max(100),
});
const listQuerySchema = z.object({
  status: z
    .enum(["candidate", "active", "superseded", "invalidated", "all"])
    .default("all"),
});
const createSchema = z
  .object({
    kind: z.enum(["fact", "preference", "relationship"]),
    key: z
      .string()
      .trim()
      .regex(/^[a-z0-9_.-]{1,100}$/),
    content: z.string().trim().min(1).max(500),
    clientRequestId: z.uuid(),
  })
  .strict();
const transitionSchema = z
  .object({
    action: z.enum(["activate", "invalidate"]),
    clientRequestId: z.uuid(),
  })
  .strict();

/** 注册记忆模块的所有 HTTP 路由 */
export function registerMemoryRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
): void {
  server.get(
    "/api/v1/conversations/:conversationId/memories",
    async (request, reply) => {
      if (!(await requireBusinessIdentity(db, request, reply))) return;
      const params = paramsSchema.safeParse(request.params);
      const query = listQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const statuses =
        query.data.status === "all"
          ? ["candidate", "active", "superseded", "invalidated"]
          : [query.data.status];
      const rows = await listConversationMemories(
        db,
        params.data.conversationId,
        statuses,
      );
      return { memories: rows.map((row) => row.memory) };
    },
  );

  server.post(
    "/api/v1/conversations/:conversationId/memories",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      const body = createSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const result = await createManualMemory(db, {
        conversationId: params.data.conversationId,
        actorUserId: identity.user.userId,
        clientRequestId: body.data.clientRequestId,
        sourceIp: request.ip,
        kind: body.data.kind,
        memoryKey: body.data.key,
        content: body.data.content,
      });
      if (result.status === "conversation_not_found") {
        return reply.code(404).send({ error: "conversation_not_found" });
      }
      if (result.status === "idempotency_conflict") {
        return reply.code(409).send({ error: "idempotency_conflict" });
      }
      return reply
        .code(result.replayed ? 200 : 201)
        .send({ memory: result.memory, replayed: result.replayed });
    },
  );

  server.post(
    "/api/v1/conversations/:conversationId/memories/:memoryId/actions",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = memoryParamsSchema.safeParse(request.params);
      const body = transitionSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const result = await transitionMemory(db, {
        conversationId: params.data.conversationId,
        memoryId: params.data.memoryId,
        actorUserId: identity.user.userId,
        clientRequestId: body.data.clientRequestId,
        sourceIp: request.ip,
        action: body.data.action,
      });
      if (result.status === "not_found") {
        return reply.code(404).send({ error: "memory_not_found" });
      }
      if (result.status === "invalid_transition") {
        return reply.code(409).send({ error: "invalid_memory_transition" });
      }
      if (result.status === "idempotency_conflict") {
        return reply.code(409).send({ error: "idempotency_conflict" });
      }
      return { memory: result.memory, replayed: result.replayed };
    },
  );
}

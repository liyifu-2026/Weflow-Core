/**
 * 协作模块 HTTP 路由
 *
 * 注册协作请求（协助/升级）的 REST API 端点，包括：
 * - 专业队列查询
 * - 协助请求和升级请求的 CRUD 操作
 * - 请求的认领、回答和关闭
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import {
  answerCollaborationRequest,
  cancelCollaborationRequest,
  claimCollaborationRequest,
  closeCollaborationRequest,
  createCollaborationRequest,
  listConversationCollaboration,
  listSpecialistQueues,
} from "../application/collaboration-service.js";

const conversationParams = z.object({
  conversationId: z.string().min(1).max(300),
});
const requestParams = z.object({ requestId: z.string().min(1).max(100) });
const createBody = z
  .object({
    handoffId: z.string().min(1).max(100),
    queueId: z.string().min(1).max(36),
    reason: z.string().trim().min(1).max(2_000),
    clientRequestId: z.uuid(),
  })
  .strict();
const claimBody = z.object({ clientRequestId: z.uuid() }).strict();
const answerBody = z
  .object({ resolution: z.string().trim().min(1).max(4_000) })
  .strict();

/** 注册协作模块的所有 HTTP 路由 */
export function registerCollaborationRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
): void {
  server.get("/api/v1/specialist-queues", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    return { queues: await listSpecialistQueues(db) };
  });

  for (const kind of ["assist", "escalation"] as const) {
    const path = kind === "assist" ? "assistance-requests" : "escalations";
    server.get(
      `/api/v1/conversations/:conversationId/${path}`,
      async (request, reply) => {
        const identity = await requireBusinessIdentity(db, request, reply);
        if (!identity) return;
        const params = conversationParams.safeParse(request.params);
        if (!params.success)
          return reply.code(400).send({ error: "invalid_request" });
        const requests = await listConversationCollaboration(db, {
          conversationId: params.data.conversationId,
          actorUserId: identity.user.userId,
        });
        return {
          requests: requests
            .filter((item) => item.kind === kind)
            .map((item) => ({
              ...item,
              reason:
                item.createdByUserId === identity.user.userId ||
                item.claimedByUserId === identity.user.userId
                  ? item.reason
                  : item.claimSummary,
            })),
        };
      },
    );
    server.post(
      `/api/v1/conversations/:conversationId/${path}`,
      async (request, reply) => {
        const identity = await requireBusinessIdentity(db, request, reply);
        if (!identity) return;
        const params = conversationParams.safeParse(request.params);
        const body = createBody.safeParse(request.body);
        if (!params.success || !body.success)
          return reply.code(400).send({ error: "invalid_request" });
        return sendResult(
          reply,
          await createCollaborationRequest(db, {
            conversationId: params.data.conversationId,
            handoffId: body.data.handoffId,
            actorUserId: identity.user.userId,
            kind,
            queueId: body.data.queueId,
            reason: body.data.reason,
            clientRequestId: body.data.clientRequestId,
            sourceIp: request.ip,
          }),
        );
      },
    );
  }

  server.post(
    "/api/v1/collaboration-requests/:requestId/claim",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = requestParams.safeParse(request.params);
      const body = claimBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      return sendResult(
        reply,
        await claimCollaborationRequest(db, {
          requestId: params.data.requestId,
          actorUserId: identity.user.userId,
          clientRequestId: body.data.clientRequestId,
          sourceIp: request.ip,
        }),
      );
    },
  );

  server.post(
    "/api/v1/collaboration-requests/:requestId/answer",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = requestParams.safeParse(request.params);
      const body = answerBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      return sendResult(
        reply,
        await answerCollaborationRequest(db, {
          requestId: params.data.requestId,
          actorUserId: identity.user.userId,
          resolution: body.data.resolution,
          sourceIp: request.ip,
        }),
      );
    },
  );

  server.post(
    "/api/v1/collaboration-requests/:requestId/close",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = requestParams.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      return sendResult(
        reply,
        await closeCollaborationRequest(db, {
          requestId: params.data.requestId,
          actorUserId: identity.user.userId,
          sourceIp: request.ip,
        }),
      );
    },
  );

  server.post(
    "/api/v1/collaboration-requests/:requestId/cancel",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = requestParams.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      return sendResult(
        reply,
        await cancelCollaborationRequest(db, {
          requestId: params.data.requestId,
          actorUserId: identity.user.userId,
          sourceIp: request.ip,
        }),
      );
    },
  );
}

/** 根据业务结果状态码映射为 HTTP 响应 */
function sendResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof createCollaborationRequest>>,
) {
  if (result.status === "ok")
    return reply
      .code(result.replayed ? 200 : 201)
      .send({ request: result.request, replayed: result.replayed });
  const status =
    result.status === "not_assignee" || result.status === "not_queue_member"
      ? 403
      : result.status === "queue_not_found" ||
          result.status === "handoff_not_found"
        ? 404
        : 409;
  return reply.code(status).send({ error: result.status });
}

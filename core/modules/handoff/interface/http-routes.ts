/**
 * 人工接管 HTTP 路由
 * 提供人工接管的创建、认领、接管、释放、解决、转交和查询等 API 端点。
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { conversationEvents } from "../../../infrastructure/events/conversation-events.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import {
  acceptHandoff,
  createHandoff,
  getHandoff,
  releaseHandoff,
  resolveHandoff,
  takeOverHandoff,
  transferHandoff,
  type HandoffResult,
} from "../application/handoff-service.js";
import {
  claimMobileHandoff,
  finishMobileHandoff,
  getMobileCapabilities,
  getMobileHandoffDetail,
  getMobileOperationOutcome,
  getTransferPreview,
  inferFinishContext,
  listMobileAssignees,
  listMobileHandoffInbox,
  listMobileQueueTargets,
  rejectMobileTransfer,
  recordHandoffQualityFeedback,
  transferMobileHandoff,
} from "../application/mobile-handoff-service.js";

const paramsSchema = z.object({
  conversationId: z.string().min(1).max(300),
});
const transitionBody = z
  .object({
    summary: z.string().trim().min(1).max(1_000),
    clientRequestId: z.uuid(),
  })
  .strict();
/**
 * 主动接管（Manual Takeover）请求体。
 * 与 transitionBody 的语义区别：summary 是可选 takeoverReason（默认不要求填写），
 * 并可携带 sourceConversationRevision 供审计。
 */
const takeoverBody = z
  .object({
    summary: z.string().trim().min(1).max(1_000).optional(),
    sourceConversationRevision: z.number().int().min(0).optional(),
    clientRequestId: z.uuid(),
  })
  .strict();
const transferBody = transitionBody.extend({ targetUserId: z.uuid() }).strict();
const mobileRevisionBody = z
  .object({
    expectedHandoffRevision: z.number().int().min(1),
    clientRequestId: z.uuid(),
  })
  .strict();
const mobileTransferBody = z
  .object({
    targetType: z.enum(["user", "queue"]),
    targetId: z.string().min(1).max(36),
    transferReason: z.string().trim().max(500).optional(),
    sourceConversationRevision: z.number().int().min(0),
    expectedHandoffRevision: z.number().int().min(1),
    clientRequestId: z.uuid(),
  })
  .strict();
const transferPreviewBody = z
  .object({
    targetType: z.enum(["user", "queue"]),
    targetId: z.string().min(1).max(36),
  })
  .strict();
const finishBody = mobileRevisionBody
  .extend({
    result: z
      .enum([
        "resolved_by_human",
        "answered_question",
        "information_collected",
        "customer_no_response",
        "other",
      ])
      .optional(),
  })
  .strict();
const outcomeQuery = z.object({
  operation: z.enum([
    "claim_handoff",
    "reject_transfer",
    "transfer_handoff",
    "finish_handoff",
    "take_over",
  ]),
  clientRequestId: z.uuid(),
});
const mobileInboxQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const briefFeedbackBody = z
  .object({
    cycleId: z.string().min(1).max(100),
    briefVersion: z.number().int().min(1),
    clientRequestId: z.uuid(),
  })
  .strict();
const messageFeedbackParams = paramsSchema.extend({
  messageId: z.string().min(1).max(600),
});
const messageFeedbackBody = z
  .object({
    cycleId: z.string().min(1).max(100),
    clientRequestId: z.uuid(),
  })
  .strict();

/** 注册人工接管相关的 HTTP 路由 */
export function registerHandoffRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
): void {
  server.get("/api/v1/mobile/capabilities", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    return { capabilities: getMobileCapabilities() };
  });

  server.get("/api/v1/mobile/handoffs/inbox", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const query = mobileInboxQuery.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    return {
      items: await listMobileHandoffInbox(
        db,
        identity.user.userId,
        query.data.limit,
      ),
    };
  });

  server.get("/api/v1/mobile/request-outcomes", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const query = outcomeQuery.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    return getMobileOperationOutcome(
      db,
      identity.user.userId,
      query.data.operation,
      query.data.clientRequestId,
    );
  });

  server.get("/api/v1/handoff-assignees", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    return {
      users: await listMobileAssignees(db, identity.user.userId),
    };
  });

  server.get("/api/v1/handoff-targets/queues", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    return { queues: await listMobileQueueTargets(db) };
  });

  server.get(
    "/api/v1/conversations/:conversationId/handoff",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const mobile = await getMobileHandoffDetail(
        db,
        params.data.conversationId,
        identity.user.userId,
      );
      if (mobile) return { handoff: mobile };
      const handoff = await getHandoff(db, params.data.conversationId);
      return handoff
        ? { handoff }
        : reply.code(404).send({ error: "handoff_not_found" });
    },
  );

  const transitions = [
    { path: "", action: createHandoff, body: transitionBody },
    {
      path: "/take-over",
      action: takeOverHandoff,
      body: takeoverBody,
      eventType: "ownership_changed" as const,
    },
    { path: "/release", action: releaseHandoff, body: transitionBody },
    { path: "/resolve", action: resolveHandoff, body: transitionBody },
  ] as const;
  for (const transition of transitions) {
    server.post(
      `/api/v1/conversations/:conversationId/handoff${transition.path}`,
      async (request, reply) => {
        const identity = await requireBusinessIdentity(db, request, reply);
        if (!identity) return;
        const params = paramsSchema.safeParse(request.params);
        const body = transition.body.safeParse(request.body);
        if (!params.success || !body.success) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        const result = await transition.action(db, {
          conversationId: params.data.conversationId,
          actorUserId: identity.user.userId,
          clientRequestId: body.data.clientRequestId,
          ...(body.data.summary !== undefined
            ? { summary: body.data.summary }
            : {}),
          ...("sourceConversationRevision" in body.data &&
          body.data.sourceConversationRevision !== undefined
            ? {
                sourceConversationRevision:
                  body.data.sourceConversationRevision,
              }
            : {}),
          sourceIp: request.ip,
        });
        return sendTransitionResult(
          reply,
          result,
          "eventType" in transition ? transition.eventType : undefined,
        );
      },
    );
  }

  server.post(
    "/api/v1/conversations/:conversationId/handoff/accept",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      const mobileBody = mobileRevisionBody.safeParse(request.body);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      if (mobileBody.success) {
        return sendMobileResult(
          reply,
          await claimMobileHandoff(db, {
            conversationId: params.data.conversationId,
            actorUserId: identity.user.userId,
            ...mobileBody.data,
            sourceIp: request.ip,
          }),
        );
      }
      const legacyBody = transitionBody.safeParse(request.body);
      if (!legacyBody.success)
        return reply.code(400).send({ error: "invalid_request" });
      return sendTransitionResult(
        reply,
        await acceptHandoff(db, {
          conversationId: params.data.conversationId,
          actorUserId: identity.user.userId,
          ...legacyBody.data,
          sourceIp: request.ip,
        }),
      );
    },
  );

  server.post(
    "/api/v1/conversations/:conversationId/handoff/brief-feedback",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      const body = briefFeedbackBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await recordHandoffQualityFeedback(db, {
        conversationId: params.data.conversationId,
        actorUserId: identity.user.userId,
        cycleId: body.data.cycleId,
        briefVersion: body.data.briefVersion,
        clientRequestId: body.data.clientRequestId,
        kind: "brief_incorrect",
      });
      return sendFeedbackResult(reply, result);
    },
  );

  server.post(
    "/api/v1/conversations/:conversationId/messages/:messageId/review-feedback",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = messageFeedbackParams.safeParse(request.params);
      const body = messageFeedbackBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await recordHandoffQualityFeedback(db, {
        conversationId: params.data.conversationId,
        actorUserId: identity.user.userId,
        cycleId: body.data.cycleId,
        messageId: params.data.messageId,
        clientRequestId: body.data.clientRequestId,
        kind: "human_message_review",
      });
      return sendFeedbackResult(reply, result);
    },
  );

  server.post(
    "/api/v1/conversations/:conversationId/handoff/transfer-preview",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      const body = transferPreviewBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const preview = await getTransferPreview(db, {
        conversationId: params.data.conversationId,
        actorUserId: identity.user.userId,
        ...body.data,
      });
      return preview
        ? preview
        : reply.code(409).send({ error: "handoff_transfer_unavailable" });
    },
  );

  server.post(
    "/api/v1/conversations/:conversationId/handoff/transfer",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const mobileBody = mobileTransferBody.safeParse(request.body);
      if (mobileBody.success) {
        return sendMobileResult(
          reply,
          await transferMobileHandoff(db, {
            conversationId: params.data.conversationId,
            actorUserId: identity.user.userId,
            ...mobileBody.data,
            sourceIp: request.ip,
          }),
        );
      }
      const body = transferBody.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_request" });
      return sendTransitionResult(
        reply,
        await transferHandoff(db, {
          conversationId: params.data.conversationId,
          actorUserId: identity.user.userId,
          targetUserId: body.data.targetUserId,
          clientRequestId: body.data.clientRequestId,
          summary: body.data.summary,
          sourceIp: request.ip,
        }),
      );
    },
  );

  server.post(
    "/api/v1/conversations/:conversationId/handoff/reject-transfer",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      const body = mobileRevisionBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      return sendMobileResult(
        reply,
        await rejectMobileTransfer(db, {
          conversationId: params.data.conversationId,
          actorUserId: identity.user.userId,
          ...body.data,
          sourceIp: request.ip,
        }),
      );
    },
  );

  server.get(
    "/api/v1/conversations/:conversationId/handoff/finish-context",
    async (request, reply) => {
      if (!(await requireBusinessIdentity(db, request, reply))) return;
      const params = paramsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      return inferFinishContext(db, params.data.conversationId);
    },
  );

  server.post(
    "/api/v1/conversations/:conversationId/handoff/finish",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = paramsSchema.safeParse(request.params);
      const body = finishBody.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      return sendMobileResult(
        reply,
        await finishMobileHandoff(db, {
          conversationId: params.data.conversationId,
          actorUserId: identity.user.userId,
          expectedHandoffRevision: body.data.expectedHandoffRevision,
          clientRequestId: body.data.clientRequestId,
          ...(body.data.result === undefined
            ? {}
            : { result: body.data.result }),
          sourceIp: request.ip,
        }),
      );
    },
  );
}

function sendMobileResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof claimMobileHandoff>>,
) {
  if (result.status === "ok") {
    publishHandoffEvent(result);
    return reply.code(result.replayed ? 200 : 201).send({
      handoff: result.handoff,
      replayed: result.replayed,
    });
  }
  const status =
    result.status === "not_found"
      ? 404
      : result.status === "not_assignee" || result.status === "not_eligible"
        ? 403
        : 409;
  const error =
    result.status === "revision_conflict"
      ? "handoff_revision_conflict"
      : result.status === "conversation_revision_conflict"
        ? "conversation_revision_conflict"
        : result.status === "not_assignee"
          ? "handoff_not_assignee"
          : result.status === "not_eligible"
            ? "handoff_target_not_eligible"
            : result.status === "idempotency_conflict"
              ? "idempotency_key_reused"
              : result.status === "customer_no_response_not_eligible"
                ? "customer_no_response_not_eligible"
                : result.status === "not_found"
                  ? "handoff_not_found"
                  : "invalid_handoff_transition";
  return reply.code(status).send({ error, handoff: result.handoff });
}

function sendFeedbackResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<typeof recordHandoffQualityFeedback>>,
) {
  if (result.status === "ok")
    return reply.code(result.replayed ? 200 : 201).send(result);
  if (result.status === "not_found")
    return reply.code(404).send({ error: "feedback_subject_not_found" });
  if (result.status === "revision_conflict")
    return reply.code(409).send({ error: "brief_revision_conflict" });
  return reply.code(409).send({ error: "idempotency_key_reused" });
}

/** 将人工接管操作结果转换为对应的 HTTP 响应 */
function sendTransitionResult(
  reply: FastifyReply,
  result: HandoffResult,
  eventType?: "ownership_changed",
) {
  if (result.status === "conversation_not_found") {
    return reply.code(404).send({ error: "conversation_not_found" });
  }
  if (result.status === "invalid_transition") {
    return reply.code(409).send({ error: "invalid_handoff_transition" });
  }
  if (result.status === "not_assignee") {
    return reply.code(403).send({ error: "handoff_not_assignee" });
  }
  if (result.status === "assignee_not_found") {
    return reply.code(404).send({ error: "handoff_assignee_not_found" });
  }
  if (result.status === "already_claimed") {
    return reply.code(409).send({
      error: "handoff_already_claimed",
      handoff: result.handoff,
      assignee: result.assignee,
    });
  }
  if (result.status === "idempotency_conflict") {
    return reply.code(409).send({ error: "idempotency_conflict" });
  }
  publishHandoffEvent(result, eventType);
  return reply.code(result.replayed ? 200 : 201).send({
    handoff: result.handoff,
    replayed: result.replayed,
  });
}

/** 根据 handoff 结果发布会话事件（事件只触发失效，客户端回拉权威状态） */
function publishHandoffEvent(
  result: Awaited<ReturnType<typeof claimMobileHandoff>> | HandoffResult,
  eventTypeOverride?: "ownership_changed",
) {
  const handoff =
    "handoff" in result
      ? result.handoff
      : (result as HandoffResult & { handoff?: { conversationId?: string } })
          .handoff;
  if (!handoff?.conversationId || result.status !== "ok") return;
  const conversationId = handoff.conversationId;
  const status = ((handoff as { status?: string }).status ?? "").toLowerCase();
  let type:
    | "handoff_created"
    | "handoff_claimed"
    | "handoff_transferred"
    | "handoff_finished"
    | "ownership_changed"
    | "conversation_updated" = "conversation_updated";
  if (eventTypeOverride) {
    type = eventTypeOverride;
  } else if (status === "pending" || status === "handoff_pending")
    type = "handoff_created";
  else if (status === "in_progress" || status === "human_active")
    type = "handoff_claimed";
  else if (status === "transfer_pending") type = "handoff_transferred";
  else if (status === "resolved" || status === "human_finished")
    type = "handoff_finished";
  conversationEvents.publish({
    type,
    conversationId,
    occurredAt: new Date().toISOString(),
  });
}

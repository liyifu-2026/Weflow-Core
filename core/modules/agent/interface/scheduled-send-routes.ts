/**
 * 定时发送 HTTP 路由（SCHEDULED-SEND-PLAN B3）。
 * 人工客服的知晓与管控面：
 * - GET /api/v1/scheduled-sends           全局「时间-任务」表（可按状态筛选）
 * - GET /api/v1/conversations/:id/scheduled-sends  会话维度的待发/最近列表
 * - POST /api/v1/scheduled-sends/:id/cancel        撤销（pending/frozen）
 * - POST /api/v1/scheduled-sends/:id/reschedule    改期（pending/frozen）
 * - POST /api/v1/scheduled-sends/:id/fire-now      立即发/放行（handoff 中拒绝）
 */
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { requireBusinessIdentity } from "../../identity/interface/request-authentication.js";
import {
  operateScheduledSend,
  listScheduledSendsForConversation,
} from "../application/scheduled-sends.js";

const listQuerySchema = z.object({
  status: z
    .enum(["pending", "fired", "cancelled", "frozen"])
    .optional(),
  conversationId: z.string().trim().min(1).max(300).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const idParamsSchema = z.object({
  scheduledSendId: z.string().trim().min(1).max(750),
});

const conversationParamsSchema = z.object({
  conversationId: z.string().trim().min(1).max(300),
});

const rescheduleSchema = z.object({
  sendAt: z.string().trim().min(1).max(40),
});

/** 注册定时发送相关 HTTP 路由 */
export function registerScheduledSendRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
): void {
  // 全局「时间-任务」表
  server.get("/api/v1/scheduled-sends", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });

    const conditions: SQL[] = [];
    if (query.data.status) {
      conditions.push(
        eq(schema.scheduledSends.status, query.data.status),
      );
    }
    if (query.data.conversationId) {
      conditions.push(
        eq(schema.scheduledSends.conversationId, query.data.conversationId),
      );
    }
    const rows = await db
      .select({
        scheduledSendId: schema.scheduledSends.scheduledSendId,
        conversationId: schema.scheduledSends.conversationId,
        content: schema.scheduledSends.content,
        status: schema.scheduledSends.status,
        sendAt: schema.scheduledSends.sendAt,
        cancelReason: schema.scheduledSends.cancelReason,
        createdAt: schema.scheduledSends.createdAt,
        contactName: schema.contactProfiles.sharedAlias,
        channelDisplayName: schema.contactProfiles.channelDisplayName,
        channelContactId: schema.contactProfiles.channelContactId,
      })
      .from(schema.scheduledSends)
      .innerJoin(
        schema.conversations,
        eq(
          schema.conversations.conversationId,
          schema.scheduledSends.conversationId,
        ),
      )
      .leftJoin(
        schema.contactProfiles,
        eq(
          schema.contactProfiles.contactId,
          schema.conversations.contactId,
        ),
      )
      .where(
        conditions.length > 0 ? and(...conditions) : undefined,
      )
      .orderBy(desc(schema.scheduledSends.sendAt))
      .limit(query.data.limit);
    return { scheduledSends: rows };
  });

  // 会话维度的待发/最近列表（web 会话详情 + mobile 复用）
  server.get(
    "/api/v1/conversations/:conversationId/scheduled-sends",
    async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const params = conversationParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_request" });
      const rows = await listScheduledSendsForConversation(
        db,
        params.data.conversationId,
        10,
      );
      return { scheduledSends: rows };
    },
  );

  async function applyOperation(
    operation: "cancel" | "reschedule" | "fire_now",
    scheduledSendId: string,
    newSendAt: Date | undefined,
    operatorUserId: string,
  ): Promise<
    | { status: "ok" }
    | { status: "not_found" }
    | { status: "invalid_state" }
    | { status: "handoff_active" }
  > {
    return operateScheduledSend(db, {
      scheduledSendId,
      operation,
      newSendAt,
      operatorUserId,
    });
  }

  server.post("/api/v1/scheduled-sends/:scheduledSendId/cancel", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await applyOperation(
      "cancel",
      params.data.scheduledSendId,
      undefined,
      identity.user.userId,
    );
    if (result.status === "not_found") return reply.code(404).send({ error: "scheduled_send_not_found" });
    if (result.status === "invalid_state") return reply.code(409).send({ error: "scheduled_send_invalid_state" });
    return { status: "ok" };
  });

  server.post("/api/v1/scheduled-sends/:scheduledSendId/reschedule", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const body = rescheduleSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const sendAt = new Date(body.data.sendAt);
    if (!Number.isFinite(sendAt.getTime())) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = await applyOperation(
      "reschedule",
      params.data.scheduledSendId,
      sendAt,
      identity.user.userId,
    );
    if (result.status === "not_found") return reply.code(404).send({ error: "scheduled_send_not_found" });
    if (result.status === "invalid_state") return reply.code(409).send({ error: "scheduled_send_invalid_state" });
    return { status: "ok" };
  });

  server.post("/api/v1/scheduled-sends/:scheduledSendId/fire-now", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await applyOperation(
      "fire_now",
      params.data.scheduledSendId,
      undefined,
      identity.user.userId,
    );
    if (result.status === "not_found") return reply.code(404).send({ error: "scheduled_send_not_found" });
    if (result.status === "invalid_state") return reply.code(409).send({ error: "scheduled_send_invalid_state" });
    if (result.status === "handoff_active") return reply.code(409).send({ error: "handoff_active" });
    return { status: "ok" };
  });
}

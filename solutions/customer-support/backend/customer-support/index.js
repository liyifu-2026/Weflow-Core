/**
 * Customer Support backend plugin.
 *
 * This module is loaded by the Weflow Core backend plugin loader at runtime.
 * It demonstrates how a business pack can provide its own HTTP routes and
 * domain service without hardcoding them into Core.
 */
import { createHandoffService } from "./handoff-service.js";
import { createAiEmployeesService } from "./ai-employees-service.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const promptsPath = join(currentDir, "..", "..", "plugins", "customer-support-strategy", "prompts.json");

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function registerRoutes(server, ctx) {
  const { db, schema, count, eq, gte, inArray, desc } = ctx;
  const handoffService = createHandoffService(ctx);
  const aiEmployeesService = createAiEmployeesService(ctx);

  server.get("/customer-support/status", async () => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [conversations, handoffs, installations] = await Promise.all([
      db
        .select({ value: count() })
        .from(schema.conversations)
        .where(gte(schema.conversations.createdAt, since24h)),
      db
        .select({ value: count() })
        .from(schema.handoffStates)
        .where(
          inArray(schema.handoffStates.status, ["pending", "transfer_pending"]),
        ),
      db
        .select()
        .from(schema.solutionInstallations)
        .where(
          eq(schema.solutionInstallations.solutionId, "weflow.customer-support"),
        )
        .limit(1),
    ]);
    return {
      service: "customer-support",
      todayConversations: conversations[0]?.value ?? 0,
      pendingHandoffs: handoffs[0]?.value ?? 0,
      observedState: installations[0]?.observedState ?? null,
      healthState: installations[0]?.healthState ?? null,
    };
  });

  server.get("/customer-support/handoffs", async () => {
    const rows = await db
      .select({
        conversationId: schema.handoffStates.conversationId,
        status: schema.handoffStates.status,
        reason: schema.handoffStates.reason,
        pendingSince: schema.handoffStates.pendingSince,
        createdAt: schema.handoffStates.createdAt,
        contactName: schema.contactProfiles.channelDisplayName,
        channel: schema.conversations.channel,
      })
      .from(schema.handoffStates)
      .leftJoin(
        schema.conversations,
        eq(schema.handoffStates.conversationId, schema.conversations.conversationId),
      )
      .leftJoin(
        schema.contactProfiles,
        eq(schema.conversations.contactId, schema.contactProfiles.contactId),
      )
      .where(
        inArray(schema.handoffStates.status, ["pending", "transfer_pending"]),
      )
      .orderBy(desc(schema.handoffStates.pendingSince))
      .limit(50);
    return { handoffs: rows };
  });

  server.get("/customer-support/handoffs/:conversationId", async (request) => {
    const conversationId = String(request.params?.conversationId ?? "");
    const rows = await db
      .select({
        conversationId: schema.handoffStates.conversationId,
        status: schema.handoffStates.status,
        reason: schema.handoffStates.reason,
        pendingSince: schema.handoffStates.pendingSince,
        assignedUserId: schema.handoffStates.assignedUserId,
        assignedQueueId: schema.handoffStates.assignedQueueId,
        contactName: schema.contactProfiles.channelDisplayName,
        channel: schema.conversations.channel,
      })
      .from(schema.handoffStates)
      .leftJoin(
        schema.conversations,
        eq(schema.handoffStates.conversationId, schema.conversations.conversationId),
      )
      .leftJoin(
        schema.contactProfiles,
        eq(schema.conversations.contactId, schema.contactProfiles.contactId),
      )
      .where(eq(schema.handoffStates.conversationId, conversationId))
      .limit(1);
    return { handoff: rows[0] ?? null };
  });

  server.get(
    "/customer-support/conversations/:conversationId/messages",
    async (request) => {
      const conversationId = String(request.params?.conversationId ?? "");
      const rows = await db
        .select({
          messageId: schema.messages.messageId,
          conversationId: schema.messages.conversationId,
          direction: schema.messages.direction,
          actorType: schema.messages.actorType,
          contentType: schema.messages.contentType,
          text: schema.messages.text,
          sendState: schema.messages.sendState,
          occurredAt: schema.messages.occurredAt,
        })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversationId))
        .orderBy(schema.messages.occurredAt)
        .limit(100);
      return { messages: rows };
    },
  );

  async function requireUser(request, reply) {
    const identity = await ctx.requireBusinessIdentity(ctx.db, request, reply);
    return identity ?? undefined;
  }

  function sendTransitionResult(reply, result) {
    if (!result || result.status === "ok") {
      return reply.send(result ?? { status: "ok" });
    }
    const codes = {
      invalid_transition: 409,
      not_found: 404,
      not_assignee: 403,
      assignee_not_found: 404,
      idempotency_conflict: 409,
      lease_conflict: 409,
    };
    return reply
      .code(codes[result.status] ?? 400)
      .send({ error: result.status, reason: result.reason });
  }

  server.post(
    "/customer-support/handoffs/:conversationId/accept",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const conversationId = String(request.params?.conversationId ?? "");
      const body = request.body ?? {};
      const result = await handoffService.accept({
        conversationId,
        actorUserId: user.user.userId,
        clientRequestId: body.clientRequestId ?? crypto.randomUUID(),
        summary: body.summary,
        sourceIp: request.ip,
      });
      return sendTransitionResult(reply, result);
    },
  );

  server.post(
    "/customer-support/handoffs/:conversationId/take-over",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const conversationId = String(request.params?.conversationId ?? "");
      const body = request.body ?? {};
      const result = await handoffService.takeOver({
        conversationId,
        actorUserId: user.user.userId,
        clientRequestId: body.clientRequestId ?? crypto.randomUUID(),
        summary: body.summary,
        sourceIp: request.ip,
      });
      return sendTransitionResult(reply, result);
    },
  );

  server.post(
    "/customer-support/handoffs/:conversationId/transfer",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const conversationId = String(request.params?.conversationId ?? "");
      const body = request.body ?? {};
      const result = await handoffService.transfer({
        conversationId,
        actorUserId: user.user.userId,
        clientRequestId: body.clientRequestId ?? crypto.randomUUID(),
        summary: body.summary,
        targetUserId: body.targetUserId,
        sourceIp: request.ip,
      });
      return sendTransitionResult(reply, result);
    },
  );

  server.post(
    "/customer-support/handoffs/:conversationId/resolve",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const conversationId = String(request.params?.conversationId ?? "");
      const body = request.body ?? {};
      const result = await handoffService.resolve({
        conversationId,
        actorUserId: user.user.userId,
        clientRequestId: body.clientRequestId ?? crypto.randomUUID(),
        summary: body.summary,
        sourceIp: request.ip,
      });
      return sendTransitionResult(reply, result);
    },
  );

  server.post("/customer-support/events/:eventName", async (request) => {
    const eventName = String(request.params?.eventName ?? "");
    return {
      received: true,
      eventName,
      body: request.body,
    };
  });

  server.get("/customer-support/prompts", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    return readJsonFile(promptsPath, { default: null, contacts: {}, conversations: {} });
  });

  server.put("/customer-support/prompts", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const body = request.body ?? {};
    const next = {
      default: typeof body.default === "string" || body.default === null ? body.default : null,
      contacts: body.contacts && typeof body.contacts === "object" ? body.contacts : {},
      conversations: body.conversations && typeof body.conversations === "object" ? body.conversations : {},
    };
    writeJsonFile(promptsPath, next);
    return next;
  });

  // -------- AI Employees (definitions, versions, workspace default, bindings) -------

  function sendServiceResult(reply, result, okStatus) {
    if (!result || result.status === "ok") {
      reply.code(okStatus ?? 200);
      return reply.send(result ?? { status: "ok" });
    }
    const codes = {
      invalid_request: 400,
      ai_employee_key_exists: 409,
      ai_employee_not_found: 404,
      ai_employee_not_editable: 409,
      ai_employee_not_archivable: 409,
      ai_employee_not_versionable: 409,
      ai_employee_version_not_editable: 409,
      ai_employee_version_not_publishable: 409,
      ai_employee_version_not_rollbackable: 409,
      ai_employee_default_invalid: 400,
      contact_agent_binding_invalid: 400,
    };
    return reply
      .code(codes[result.status] ?? 400)
      .send({ error: result.status, reason: result.reason });
  }

  server.get("/api/v1/agent/ai-employees", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    return aiEmployeesService.listDefinitions();
  });

  server.post("/api/v1/agent/ai-employees", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.user.role !== "admin") {
      return reply.code(403).send({ error: "admin_required" });
    }
    const body = request.body ?? {};
    const result = await aiEmployeesService.createDefinition({
      key: body.key,
      name: body.name,
      description: body.description ?? null,
      prompt: body.prompt,
    });
    if (result.status !== "ok") return sendServiceResult(reply, result);
    reply.code(201);
    return reply.send(result);
  });

  server.patch("/api/v1/agent/ai-employees/:definitionId", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.user.role !== "admin") {
      return reply.code(403).send({ error: "admin_required" });
    }
    const definitionId = String(request.params?.definitionId ?? "");
    const result = await aiEmployeesService.updateDefinition(
      definitionId,
      request.body ?? {},
    );
    if (result.status !== "ok") return sendServiceResult(reply, result);
    return reply.send(result);
  });

  server.post(
    "/api/v1/agent/ai-employees/:definitionId/archive",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      if (user.user.role !== "admin") {
        return reply.code(403).send({ error: "admin_required" });
      }
      const definitionId = String(request.params?.definitionId ?? "");
      const result = await aiEmployeesService.archiveDefinition(definitionId);
      if (result.status !== "ok") return sendServiceResult(reply, result);
      return reply.send(result);
    },
  );

  server.post(
    "/api/v1/agent/ai-employees/:definitionId/versions",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      if (user.user.role !== "admin") {
        return reply.code(403).send({ error: "admin_required" });
      }
      const definitionId = String(request.params?.definitionId ?? "");
      const body = request.body ?? {};
      const result = await aiEmployeesService.createVersion(definitionId, body.prompt);
      if (result.status !== "ok") return sendServiceResult(reply, result);
      reply.code(201);
      return reply.send(result);
    },
  );

  server.patch(
    "/api/v1/agent/ai-employees/versions/:versionId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      if (user.user.role !== "admin") {
        return reply.code(403).send({ error: "admin_required" });
      }
      const versionId = String(request.params?.versionId ?? "");
      const body = request.body ?? {};
      const result = await aiEmployeesService.updateVersion(versionId, body.prompt);
      if (result.status !== "ok") return sendServiceResult(reply, result);
      return reply.send(result);
    },
  );

  server.post(
    "/api/v1/agent/ai-employees/versions/:versionId/publish",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      if (user.user.role !== "admin") {
        return reply.code(403).send({ error: "admin_required" });
      }
      const versionId = String(request.params?.versionId ?? "");
      const result = await aiEmployeesService.publishVersion(versionId);
      if (result.status !== "ok") return sendServiceResult(reply, result);
      return reply.send(result);
    },
  );

  server.post(
    "/api/v1/agent/ai-employees/versions/:versionId/rollback",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      if (user.user.role !== "admin") {
        return reply.code(403).send({ error: "admin_required" });
      }
      const versionId = String(request.params?.versionId ?? "");
      const result = await aiEmployeesService.rollbackVersion(versionId);
      if (result.status !== "ok") return sendServiceResult(reply, result);
      return reply.send(result);
    },
  );

  server.get("/api/v1/agent/workspace-default", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    return aiEmployeesService.getWorkspaceDefault();
  });

  server.put("/api/v1/agent/workspace-default", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.user.role !== "admin") {
      return reply.code(403).send({ error: "admin_required" });
    }
    const body = request.body ?? {};
    await aiEmployeesService.setWorkspaceDefault(body.definitionId ?? null);
    return aiEmployeesService.getWorkspaceDefault();
  });

  server.get("/api/v1/agent/contact-bindings", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    return aiEmployeesService.listContactBindings();
  });

  server.put(
    "/api/v1/agent/contact-bindings/:contactId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const contactId = String(request.params?.contactId ?? "");
      const body = request.body ?? {};
      const result = await aiEmployeesService.setContactBinding(
        contactId,
        body.definitionId,
      );
      if (result.status !== "ok") return sendServiceResult(reply, result);
      return reply.send(result);
    },
  );

  server.delete(
    "/api/v1/agent/contact-bindings/:contactId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const contactId = String(request.params?.contactId ?? "");
      await aiEmployeesService.removeContactBinding(contactId);
      return { ok: true };
    },
  );

  // ── 会话模式可视化（Phase 3/4 只读投影）──────────────────────────
  // 会话状态（session episode）：接待中/等待/已收尾 + 预算计数
  server.get(
    "/api/v1/agent/session-state/:conversationId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const conversationId = String(request.params?.conversationId ?? "");
      const [session] = await db
        .select({
          sessionId: schema.agentSessions.sessionId,
          state: schema.agentSessions.state,
          roundsUsed: schema.agentSessions.roundsUsed,
          roundBudget: schema.agentSessions.roundBudget,
          startedAt: schema.agentSessions.startedAt,
          closedAt: schema.agentSessions.closedAt,
          closureSummary: schema.agentSessions.closureSummary,
        })
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.conversationId, conversationId))
        .orderBy(desc(schema.agentSessions.startedAt))
        .limit(1);
      return { session: session ?? null };
    },
  );

  // 决策轨迹：turn_events 的可读投影（不含模型思维链）
  server.get(
    "/api/v1/agent/decision-trace/:turnId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const turnId = String(request.params?.turnId ?? "");
      const events = await db
        .select({
          eventType: schema.agentTurnEvents.eventType,
          reasonCode: schema.agentTurnEvents.reasonCode,
          payload: schema.agentTurnEvents.payload,
          createdAt: schema.agentTurnEvents.createdAt,
        })
        .from(schema.agentTurnEvents)
        .where(eq(schema.agentTurnEvents.turnId, turnId))
        .orderBy(schema.agentTurnEvents.createdAt);
      const [turn] = await db
        .select({
          turnId: schema.agentTurns.turnId,
          status: schema.agentTurns.status,
          model: schema.agentTurns.model,
          responseSegments: schema.agentTurns.responseSegments,
          traceId: schema.agentTurns.traceId,
          startedAt: schema.agentTurns.startedAt,
          completedAt: schema.agentTurns.completedAt,
        })
        .from(schema.agentTurns)
        .where(eq(schema.agentTurns.turnId, turnId))
        .limit(1);
      return { turn: turn ?? null, events };
    },
  );

  // 会话级唤醒计划（wait 时间线节点的数据源）
  server.get(
    "/api/v1/agent/session-wakes/:conversationId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const conversationId = String(request.params?.conversationId ?? "");
      const wakes = await db
        .select({
          wakeId: schema.sessionWakes.wakeId,
          turnId: schema.sessionWakes.turnId,
          kind: schema.sessionWakes.kind,
          status: schema.sessionWakes.status,
          wakeAt: schema.sessionWakes.wakeAt,
          nudgeText: schema.sessionWakes.nudgeText,
        })
        .from(schema.sessionWakes)
        .where(eq(schema.sessionWakes.conversationId, conversationId))
        .orderBy(desc(schema.sessionWakes.wakeAt))
        .limit(20);
      return { wakes };
    },
  );

  // 进行中的 Agent Turn（轮询源：产生「AI 正在思考」的体感）
  server.get(
    "/api/v1/agent/live-turn/:conversationId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const conversationId = String(request.params?.conversationId ?? "");
      const [turn] = await db
        .select({
          turnId: schema.agentTurns.turnId,
          status: schema.agentTurns.status,
          startedAt: schema.agentTurns.startedAt,
          createdAt: schema.agentTurns.createdAt,
        })
        .from(schema.agentTurns)
        .where(eq(schema.agentTurns.conversationId, conversationId))
        .orderBy(desc(schema.agentTurns.createdAt))
        .limit(1);
      if (!turn || turn.status === "completed" || turn.status === "superseded") {
        return { live: null };
      }
      const events = await db
        .select({
          eventType: schema.agentTurnEvents.eventType,
          reasonCode: schema.agentTurnEvents.reasonCode,
          payload: schema.agentTurnEvents.payload,
          createdAt: schema.agentTurnEvents.createdAt,
        })
        .from(schema.agentTurnEvents)
        .where(eq(schema.agentTurnEvents.turnId, turn.turnId))
        .orderBy(schema.agentTurnEvents.createdAt);
      const lastEvent = events.at(-1) ?? null;
      const reasoning =
        [...events].reverse().find((e) => e.eventType === "model_reasoning")
          ?.payload?.reasoning ?? null;
      return {
        live: {
          turnId: turn.turnId,
          status: turn.status,
          startedAt: turn.startedAt ?? turn.createdAt,
          lastEvent: lastEvent
            ? {
                eventType: lastEvent.eventType,
                reasonCode: lastEvent.reasonCode,
                createdAt: lastEvent.createdAt,
              }
            : null,
          reasoning,
        },
      };
    },
  );

  // 媒体备注（AI 看图结论，运营可读；修正 API 后续再加）
  server.get(
    "/api/v1/agent/media-note/:messageId",
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      const messageId = String(request.params?.messageId ?? "");
      const [asset] = await db
        .select({
          mediaId: schema.mediaAssets.mediaId,
          description: schema.mediaAssets.description,
          descriptionModel: schema.mediaAssets.descriptionModel,
          status: schema.mediaAssets.status,
          kind: schema.mediaAssets.kind,
        })
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.messageId, messageId))
        .limit(1);
      return { media: asset ?? null };
    },
  );
}

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
}

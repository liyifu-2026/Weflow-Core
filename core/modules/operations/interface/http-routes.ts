/**
 * Operations module — HTTP route handlers.
 *
 * These are pure HTTP adapters. They authenticate, validate input with Zod,
 * delegate to application-layer functions, and map results to HTTP responses.
 * They must NOT import from infrastructure/postgres/schema or call Drizzle ORM.
 */
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import {
  requireAdminIdentity,
  requireBusinessIdentity,
} from "../../identity/interface/request-authentication.js";
import {
  buildSystemStatus,
  type RuntimeCapabilities,
} from "../application/system-status.js";
import {
  readRuntimeSettings,
  rollbackRuntimeSettings,
  updateRuntimeSettings,
  readOperatorStatus,
  readRuntimeSettingsAudit,
  buildRuntimeConsole,
  TEXT_MODEL_ALLOWLIST,
  VISION_MODEL_ALLOWLIST,
  type RuntimeSettings,
} from "../application/runtime-settings.js";
import {
  readModelSettings,
  updateModelSettings,
  MODEL_NAME_ALLOWLIST,
  VISION_MODEL_NAME_ALLOWLIST,
  type ModelSettingsDefaults,
  type ModelSettingsPatch,
} from "../application/model-settings.js";
import { buildDashboardCards } from "../application/dashboard-cards.js";
import {
  readAdminOverview,
  readRuntimeStatuses,
  readAuditEvents,
  readAuditOptions,
  readAgentTurns,
  listStoreOverviews,
} from "../application/admin-overview.js";

const runtimeSettingsPatchSchema = z.object({
  agentEnabled: z.boolean().optional(),
  autoSendEnabled: z.boolean().optional(),
  knowledgeEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  visionEnabled: z.boolean().optional(),
  textModel: z.enum(TEXT_MODEL_ALLOWLIST).optional(),
  visionModel: z.enum(VISION_MODEL_ALLOWLIST).optional(),
});

const modelSettingsPatchSchema = z
  .object({
    textModel: z
      .object({
        name: z.enum(MODEL_NAME_ALLOWLIST).optional(),
        baseUrl: z.string().trim().min(1).max(500).optional(),
        apiKey: z.string().trim().max(1_000).optional(),
      })
      .optional(),
    visionModel: z
      .object({
        name: z.enum(VISION_MODEL_NAME_ALLOWLIST).optional(),
        baseUrl: z.string().trim().min(1).max(500).optional(),
        apiKey: z.string().trim().max(1_000).optional(),
      })
      .optional(),
    asrModel: z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        baseUrl: z.string().trim().min(1).max(500).optional(),
        apiKey: z.string().trim().max(1_000).optional(),
      })
      .optional(),
    /** 分流/直答模型槽位：供应商模型名自由命名（如 Qwen/Qwen2.5-7B-Instruct） */
    triageModel: z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        baseUrl: z.string().trim().min(1).max(500).optional(),
        apiKey: z.string().trim().max(1_000).optional(),
      })
      .optional(),
    fastModel: z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        baseUrl: z.string().trim().min(1).max(500).optional(),
        apiKey: z.string().trim().max(1_000).optional(),
      })
      .optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);

export function registerOperationsRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  capabilities: RuntimeCapabilities,
  modelDefaults: ModelSettingsDefaults,
): void {
  server.get("/api/v1/system/status", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    return buildSystemStatus(capabilities);
  });

  server.get("/api/v1/admin/overview", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return readAdminOverview(db, capabilities);
  });

  server.get("/api/v1/admin/runtime", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return readRuntimeStatuses(db, capabilities);
  });

  server.get("/api/v1/admin/audit", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        eventType: z.string().trim().max(100).optional(),
        actor: z.string().trim().max(100).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    const { limit, offset, eventType, actor, from, to } = query.data;
    return readAuditEvents(db, {
      limit,
      offset,
      ...(eventType !== undefined ? { eventType } : {}),
      ...(actor !== undefined ? { actor } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    });
  });

  server.get("/api/v1/admin/audit/options", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return readAuditOptions(db);
  });

  server.get("/api/v1/admin/agent-turns", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    return readAgentTurns(db, query.data.limit);
  });

  // ---------- Operator Control Plane ----------

  server.get("/api/v1/admin/runtime-settings", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return {
      settings: await readRuntimeSettings(db),
      allowlists: {
        text: TEXT_MODEL_ALLOWLIST,
        vision: VISION_MODEL_ALLOWLIST,
      },
    };
  });

  server.patch("/api/v1/admin/runtime-settings", async (request, reply) => {
    const identity = await requireAdminIdentity(db, request, reply);
    if (!identity) return;
    const body = runtimeSettingsPatchSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    if (Object.keys(body.data).length === 0)
      return reply.code(400).send({ error: "invalid_request" });
    const result = await updateRuntimeSettings(db, undefined, {
      actorUserId: identity.user.userId,
      sourceIp: request.ip,
      patch: body.data as Partial<RuntimeSettings>,
    });
    return result;
  });

  // ---------- Platform Model Settings ----------

  server.get("/api/v1/admin/model-settings", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return {
      settings: await readModelSettings(db, modelDefaults),
      allowlists: {
        text: MODEL_NAME_ALLOWLIST,
        vision: VISION_MODEL_NAME_ALLOWLIST,
      },
    };
  });

  server.patch("/api/v1/admin/model-settings", async (request, reply) => {
    const identity = await requireAdminIdentity(db, request, reply);
    if (!identity) return;
    const body = modelSettingsPatchSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const result = await updateModelSettings(db, {
      actorUserId: identity.user.userId,
      sourceIp: request.ip,
      patch: body.data as ModelSettingsPatch,
      defaults: modelDefaults,
    });
    return result;
  });

  server.post(
    "/api/v1/admin/runtime-settings/rollback",
    async (request, reply) => {
      const identity = await requireAdminIdentity(db, request, reply);
      if (!identity) return;
      return rollbackRuntimeSettings(db, undefined, {
        actorUserId: identity.user.userId,
        sourceIp: request.ip,
      });
    },
  );

  server.get("/api/v1/admin/runtime-settings/audit", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return { events: await readRuntimeSettingsAudit(db) };
  });

  server.get("/api/v1/admin/operator-status", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return readOperatorStatus(db);
  });

  server.get("/api/v1/admin/runtime-console", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return buildRuntimeConsole(db);
  });

  server.get("/api/v1/admin/console/home", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const [solutions, systemStatus] = await Promise.all([
      listStoreOverviews(),
      buildSystemStatus(capabilities),
    ]);
    return { solutions, cards: [], systemStatus };
  });

  server.get("/api/v1/admin/dashboard/cards", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return { cards: await buildDashboardCards(db) };
  });

  server.get("/api/v1/admin/solutions/health", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return { solutions: [] };
  });

  server.get("/api/v1/admin/stream", async (request, reply) => {
    const identity = await requireAdminIdentity(db, request, reply);
    if (!identity) return;

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let closed = false;
    const sendSnapshot = async () => {
      if (closed) return;
      try {
        const payload = await buildRuntimeConsole(db);
        reply.raw.write(`event: runtime\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (error) {
        request.log.error({ err: error }, "admin stream snapshot failed");
      }
    };

    void sendSnapshot();
    const timer = setInterval(() => {
      void sendSnapshot();
    }, 5_000);
    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 25_000);

    request.raw.on("close", () => {
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
    });
  });
}

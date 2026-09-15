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
  type RuntimeSettings,
} from "../application/runtime-settings.js";
import { notifyModelSettingsChanged } from "../application/model-settings-hot.js";
import {
  listModelRegistry,
  upsertModelRegistryEntry,
  deleteModelRegistryEntry,
  readSlotBindings,
  bindModelSlot,
  resolveModelProbeEndpoint,
  MODEL_SLOTS,
  type ModelRegistryPatch,
} from "../application/model-gateway.js";
import { readModelHealth, probeModelAndRecord } from "../application/model-failover.js";
import {
  readSolutionExtensionSettings,
  writeSolutionExtensionSettings,
} from "../../../infrastructure/settings/extension-settings.js";
import {
  readAdminOverview,
  readRuntimeStatuses,
  readAuditEvents,
  readAuditOptions,
  readAgentTurns,
} from "../application/admin-overview.js";

const runtimeSettingsPatchSchema = z.object({
  agentEnabled: z.boolean().optional(),
  autoSendEnabled: z.boolean().optional(),
  knowledgeEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  visionEnabled: z.boolean().optional(),
  mergeWindowEnabled: z.boolean().optional(),
});

const modelRegistryUpsertSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    baseUrl: z.string().trim().min(1).max(500).optional(),
    /** 空串/缺省 = 保持原值 */
    apiKey: z.string().max(1_000).optional(),
    capabilities: z.array(z.enum(["text", "vision", "asr"])).optional(),
    protocol: z.enum(["chat_inline", "audio_transcriptions"]).optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    failoverTo: z.string().trim().max(120).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0)
  .transform((patch) => patch as ModelRegistryPatch);

export function registerOperationsRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  capabilities: RuntimeCapabilities,
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

  // ---------- Model Gateway (R2)：统一模型注册表 + 槽位 + 健康状态 ----------

  server.get("/api/v1/admin/model-gateway", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const [models, slots] = await Promise.all([
      listModelRegistry(db),
      readSlotBindings(db),
    ]);
    return { models, slots, health: readModelHealth() };
  });

  server.put(
    "/api/v1/admin/model-gateway/models/:modelId",
    async (request, reply) => {
      const identity = await requireAdminIdentity(db, request, reply);
      if (!identity) return;
      const params = z
        .object({ modelId: z.string().trim().min(1).max(120) })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const body = modelRegistryUpsertSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await upsertModelRegistryEntry(db, {
        actorUserId: identity.user.userId,
        sourceIp: request.ip,
        modelId: params.data.modelId,
        patch: body.data,
      });
      if (result.status === "not_found")
        return reply.code(404).send({ error: "model_not_found" });
      if (result.status === "failover_cycle")
        return reply.code(409).send({ error: "failover_cycle" });
      if (result.status === "invalid_capabilities")
        return reply.code(400).send({ error: "invalid_capabilities" });
      notifyModelSettingsChanged();
      return { model: result.model };
    },
  );

  server.delete(
    "/api/v1/admin/model-gateway/models/:modelId",
    async (request, reply) => {
      const identity = await requireAdminIdentity(db, request, reply);
      if (!identity) return;
      const params = z
        .object({ modelId: z.string().trim().min(1).max(120) })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await deleteModelRegistryEntry(db, {
        actorUserId: identity.user.userId,
        sourceIp: request.ip,
        modelId: params.data.modelId,
      });
      if (!result.deleted)
        return reply.code(404).send({ error: "model_not_found" });
      notifyModelSettingsChanged();
      return { deleted: true };
    },
  );

  server.put(
    "/api/v1/admin/model-gateway/slots/:slot",
    async (request, reply) => {
      const identity = await requireAdminIdentity(db, request, reply);
      if (!identity) return;
      const params = z
        .object({ slot: z.enum(MODEL_SLOTS) })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const body = z
        .object({ modelId: z.string().trim().max(120).nullable() })
        .safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await bindModelSlot(db, {
        actorUserId: identity.user.userId,
        sourceIp: request.ip,
        slot: params.data.slot,
        modelId: body.data.modelId || null,
      });
      if (result.notFound)
        return reply.code(404).send({ error: "model_not_found" });
      if (result.capabilityMismatch)
        return reply.code(400).send({ error: "capability_mismatch" });
      notifyModelSettingsChanged();
      return { bound: true };
    },
  );

  // 「测试连接」：由 API 服务端对模型端点发一次最小补全（apiKey 是
  // secret，浏览器不持有，探测必须在服务端做）。结果写进程内健康表，
  // 设置页徽章据此展示。支持未保存的编辑中表单值（baseUrl/apiKey 覆盖，
  // apiKey 缺省沿用注册表已存密钥），实现「先测再存」。
  server.post(
    "/api/v1/admin/model-gateway/models/:modelId/test-connection",
    async (request, reply) => {
      const identity = await requireAdminIdentity(db, request, reply);
      if (!identity) return;
      const params = z
        .object({ modelId: z.string().trim().min(1).max(120) })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const body = z
        .object({
          baseUrl: z.string().trim().min(1).max(500).optional(),
          apiKey: z.string().max(1_000).optional(),
          /** 新建表单尚未落库时展示名/模型名由请求提供 */
          displayName: z.string().trim().min(1).max(200).optional(),
        })
        .strict()
        .safeParse(request.body ?? {});
      if (!body.success)
        return reply.code(400).send({ error: "invalid_request" });

      const endpoint = await resolveModelProbeEndpoint(
        db,
        params.data.modelId,
        {
          baseUrl: body.data.baseUrl,
          apiKey: body.data.apiKey,
          displayName: body.data.displayName,
        },
      );
      if (!endpoint) return reply.code(404).send({ error: "model_not_found" });
      return await probeModelAndRecord(
        endpoint.displayName,
        params.data.modelId,
        endpoint,
        endpoint.timeoutMs,
      );
    },
  );

  server.get("/api/v1/admin/runtime-settings/audit", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return { events: await readRuntimeSettingsAudit(db) };
  });

  // 扩展设置（R3：原 solution store-routes 的通用设置端点收编至此）。
  // 设置中心各分区读写 JSON；读取走 application 层的读取器。
  server.get(
    "/api/v1/admin/solutions/:solutionId/extensions/:extensionId/settings",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const params = z
        .object({
          solutionId: z.string().trim().min(1).max(200),
          extensionId: z.string().trim().min(1).max(200),
        })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const settings = await readSolutionExtensionSettings(db, {
        solutionId: params.data.solutionId,
        extensionId: params.data.extensionId,
      });
      return { settings: settings ?? {} };
    },
  );

  server.put(
    "/api/v1/admin/solutions/:solutionId/extensions/:extensionId/settings",
    async (request, reply) => {
      const identity = await requireAdminIdentity(db, request, reply);
      if (!identity) return;
      const params = z
        .object({
          solutionId: z.string().trim().min(1).max(200),
          extensionId: z.string().trim().min(1).max(200),
        })
        .safeParse(request.params);
      const body = z
        .object({
          settings: z.record(z.string(), z.unknown()),
        })
        .safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      await writeSolutionExtensionSettings(db, {
        solutionId: params.data.solutionId,
        extensionId: params.data.extensionId,
        settingsJson: body.data.settings,
        updatedBy: identity.user.userId,
      });
      return { ok: true };
    },
  );

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
    const systemStatus = await buildSystemStatus(capabilities);
    return { solutions: [], cards: [], systemStatus };
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

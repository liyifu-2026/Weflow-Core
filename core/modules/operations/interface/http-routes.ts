import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
} from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import * as schema from "../../../infrastructure/postgres/schema.js";
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
  TEXT_MODEL_ALLOWLIST,
  VISION_MODEL_ALLOWLIST,
  type RuntimeSettings,
} from "../application/runtime-settings.js";
import {
  listDashboardContributions,
  listSolutionInstallations,
} from "../../solution/application/solution-installation-service.js";

const runtimeSettingsPatchSchema = z.object({
  agentEnabled: z.boolean().optional(),
  autoSendEnabled: z.boolean().optional(),
  knowledgeEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  visionEnabled: z.boolean().optional(),
  textModel: z.enum(TEXT_MODEL_ALLOWLIST).optional(),
  visionModel: z.enum(VISION_MODEL_ALLOWLIST).optional(),
});

async function readOperatorStatus(db: NodePgDatabase<typeof schema>) {
  const settings = await readRuntimeSettings(db);
  const cursorFreshThreshold = new Date(Date.now() - 15_000);
  const [cursor, turnCounts, handoffCount, lastCompleted] = await Promise.all([
    db
      .select({ updatedAt: schema.channelCursors.updatedAt })
      .from(schema.channelCursors)
      .where(eq(schema.channelCursors.source, "channel-host"))
      .limit(1),
    db
      .select({ status: schema.agentTurns.status, value: count() })
      .from(schema.agentTurns)
      .where(inArray(schema.agentTurns.status, ["queued", "running"]))
      .groupBy(schema.agentTurns.status),
    db
      .select({ value: count() })
      .from(schema.handoffStates)
      .where(
        inArray(schema.handoffStates.status, ["pending", "transfer_pending"]),
      ),
    db
      .select({ completedAt: schema.agentTurns.completedAt })
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.status, "completed"))
      .orderBy(desc(schema.agentTurns.completedAt))
      .limit(1),
  ]);
  const queued = turnCounts.find((row) => row.status === "queued");
  const running = turnCounts.find((row) => row.status === "running");
  return {
    channelOnline: Boolean(
      cursor[0] && cursor[0].updatedAt > cursorFreshThreshold,
    ),
    agentEnabled: settings.agentEnabled,
    autoSendEnabled: settings.autoSendEnabled,
    queuedTurnCount: queued?.value ?? 0,
    runningTurnCount: running?.value ?? 0,
    pendingHandoffCount: handoffCount[0]?.value ?? 0,
    lastCompletedTurnAt: lastCompleted[0]?.completedAt ?? null,
  };
}

async function readRuntimeSettingsAudit(db: NodePgDatabase<typeof schema>) {
  return db
    .select({
      auditId: schema.auditEvents.auditId,
      actorUsername: schema.users.username,
      eventType: schema.auditEvents.eventType,
      subjectId: schema.auditEvents.subjectId,
      metadata: schema.auditEvents.metadata,
      createdAt: schema.auditEvents.createdAt,
    })
    .from(schema.auditEvents)
    .leftJoin(
      schema.users,
      eq(schema.users.userId, schema.auditEvents.actorUserId),
    )
    .where(
      inArray(schema.auditEvents.eventType, [
        "operator.runtime_settings_updated",
        "operator.runtime_settings_rolled_back",
      ]),
    )
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(50);
}

async function buildRuntimeConsole(db: NodePgDatabase<typeof schema>) {
  const [settings, status, audit] = await Promise.all([
    readRuntimeSettings(db),
    readOperatorStatus(db),
    readRuntimeSettingsAudit(db),
  ]);
  return {
    settings,
    allowlists: {
      text: TEXT_MODEL_ALLOWLIST,
      vision: VISION_MODEL_ALLOWLIST,
    },
    status,
    audit,
  };
}

async function listDashboardCards(db: NodePgDatabase<typeof schema>) {
  const solutions = await listDashboardContributions(db);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cards: Array<Record<string, unknown>> = [];
  for (const solution of solutions) {
    for (const raw of solution.contributions) {
      const contribution = raw as {
        id?: string;
        title?: string;
        defaultPosition?: { x: number; y: number; w: number; h: number };
        refreshInterval?: number;
      };
      const cardId = `${solution.solutionId}.${contribution.id ?? "card"}`;
      const position = contribution.defaultPosition ?? {
        x: 0,
        y: 0,
        w: 3,
        h: 2,
      };
      let data: unknown = null;
      let status: "ready" | "empty" = "empty";
      const error: string | null = null;
      // 平台内置卡片数据钩子：按 contribution.id 计算，与 Solution 无关
      if (contribution.id === "today-consultations") {
        const rows = await db
          .select({ value: count() })
          .from(schema.conversations)
          .where(gte(schema.conversations.createdAt, since24h));
        data = { value: rows[0]?.value ?? 0, unit: "会话" };
        status = "ready";
      } else if (contribution.id === "pending-handoffs") {
        const rows = await db
          .select({ value: count() })
          .from(schema.handoffStates)
          .where(
            inArray(schema.handoffStates.status, [
              "pending",
              "transfer_pending",
            ]),
          );
        data = { value: rows[0]?.value ?? 0, unit: "个" };
        status = "ready";
      } else if (contribution.id === "solution-status") {
        const rows = await db
          .select()
          .from(schema.solutionInstallations)
          .where(
            eq(schema.solutionInstallations.solutionId, solution.solutionId),
          )
          .limit(1);
        const current = rows[0];
        data = current
          ? {
              observedState: current.observedState,
              healthState: current.healthState,
            }
          : null;
        status = current ? "ready" : "empty";
      }
      cards.push({
        id: cardId,
        title: contribution.title ?? "业务卡片",
        position,
        refreshInterval: contribution.refreshInterval ?? 30_000,
        data,
        status,
        error,
      });
    }
  }
  return cards;
}

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
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const [conversationRows, handoffRows, failedTurnRows] = await Promise.all([
      db.select({ value: count() }).from(schema.conversations),
      db
        .select({ value: count() })
        .from(schema.handoffStates)
        .where(eq(schema.handoffStates.status, "pending")),
      db
        .select({ value: count() })
        .from(schema.agentTurns)
        .where(
          and(
            eq(schema.agentTurns.status, "failed"),
            gte(schema.agentTurns.createdAt, since),
          ),
        ),
    ]);
    return {
      conversations: conversationRows[0]?.value ?? 0,
      pendingHandoffs: handoffRows[0]?.value ?? 0,
      failedTurns24h: failedTurnRows[0]?.value ?? 0,
      capabilities,
    };
  });

  server.get("/api/v1/admin/runtime", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const statuses = await db
      .select({ status: schema.agentTurns.status, value: count() })
      .from(schema.agentTurns)
      .groupBy(schema.agentTurns.status);
    return {
      components: [
        { key: "core", name: "Weflow Core", status: "ready" },
        {
          key: "channel-host",
          name: "Channel Host",
          status: capabilities.channelHostConfigured
            ? "configured"
            : "not_configured",
        },
        {
          key: "model",
          name: "Model Runtime",
          status: capabilities.modelConfigured
            ? "configured"
            : "not_configured",
        },
        {
          key: "knowledge",
          name: "知识服务",
          status: capabilities.knowledgeConfigured
            ? "configured"
            : "not_configured",
        },
      ],
      turnCounts: Object.fromEntries(
        statuses.map((item) => [item.status, item.value]),
      ),
    };
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
    const events = await db
      .select({
        auditId: schema.auditEvents.auditId,
        actorUserId: schema.auditEvents.actorUserId,
        actorUsername: schema.users.username,
        eventType: schema.auditEvents.eventType,
        subjectType: schema.auditEvents.subjectType,
        subjectId: schema.auditEvents.subjectId,
        sourceIp: schema.auditEvents.sourceIp,
        metadata: schema.auditEvents.metadata,
        createdAt: schema.auditEvents.createdAt,
      })
      .from(schema.auditEvents)
      .leftJoin(
        schema.users,
        eq(schema.users.userId, schema.auditEvents.actorUserId),
      )
      .where(
        and(
          query.data.eventType
            ? eq(schema.auditEvents.eventType, query.data.eventType)
            : undefined,
          query.data.actor
            ? eq(schema.users.username, query.data.actor)
            : undefined,
          query.data.from
            ? gte(schema.auditEvents.createdAt, new Date(query.data.from))
            : undefined,
          query.data.to
            ? lte(schema.auditEvents.createdAt, new Date(query.data.to))
            : undefined,
        ),
      )
      .orderBy(desc(schema.auditEvents.createdAt))
      .limit(query.data.limit)
      .offset(query.data.offset);
    return { events, hasMore: events.length === query.data.limit };
  });

  server.get("/api/v1/admin/audit/options", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const [eventTypeRows, actorRows] = await Promise.all([
      db
        .selectDistinct({ eventType: schema.auditEvents.eventType })
        .from(schema.auditEvents)
        .orderBy(asc(schema.auditEvents.eventType)),
      db
        .selectDistinct({ username: schema.users.username })
        .from(schema.auditEvents)
        .leftJoin(
          schema.users,
          eq(schema.users.userId, schema.auditEvents.actorUserId),
        )
        .where(isNotNull(schema.users.username))
        .orderBy(asc(schema.users.username)),
    ]);
    return {
      eventTypes: eventTypeRows.map((row) => row.eventType),
      actors: actorRows
        .map((row) => row.username)
        .filter((username): username is string => Boolean(username)),
    };
  });

  server.get("/api/v1/admin/agent-turns", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    const turns = await db
      .select({
        turnId: schema.agentTurns.turnId,
        conversationId: schema.agentTurns.conversationId,
        status: schema.agentTurns.status,
        model: schema.agentTurns.model,
        errorCode: schema.agentTurns.errorCode,
        createdAt: schema.agentTurns.createdAt,
        completedAt: schema.agentTurns.completedAt,
      })
      .from(schema.agentTurns)
      .orderBy(desc(schema.agentTurns.createdAt))
      .limit(query.data.limit);
    return { turns };
  });

  // ---------- Operator Control Plane（Phase 3） ----------

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
    const [solutions, cards, systemStatus] = await Promise.all([
      listSolutionInstallations(db),
      listDashboardCards(db),
      buildSystemStatus(capabilities),
    ]);
    return { solutions, cards, systemStatus };
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

/**
 * Admin overview and audit query services.
 *
 * Extracted from interface/http-routes.ts to enforce the rule that route
 * handlers must not import from infrastructure/postgres/schema or call
 * Drizzle ORM directly. All DB access lives here; route handlers call
 * these functions and map the result to HTTP responses.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  lte,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { RuntimeCapabilities } from "./system-status.js";
import { listStoreOverviews } from "../../../infrastructure/solutions/solution-store.js";

export { listStoreOverviews };

export type AdminOverview = {
  conversations: number;
  pendingHandoffs: number;
  failedTurns24h: number;
  capabilities: RuntimeCapabilities;
};

export async function readAdminOverview(
  db: NodePgDatabase<typeof schema>,
  capabilities: RuntimeCapabilities,
): Promise<AdminOverview> {
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
}

export type RuntimeStatuses = {
  components: Array<{ key: string; name: string; status: string }>;
  turnCounts: Record<string, number>;
};

export async function readRuntimeStatuses(
  db: NodePgDatabase<typeof schema>,
  capabilities: RuntimeCapabilities,
): Promise<RuntimeStatuses> {
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
        status: capabilities.modelConfigured ? "configured" : "not_configured",
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
}

export type AuditEventRow = {
  auditId: string;
  actorUserId: string | null;
  actorUsername: string | null;
  eventType: string;
  subjectType: string;
  subjectId: string | null;
  sourceIp: string | null;
  metadata: Record<string, string>;
  createdAt: Date;
};

export type AuditEventsResult = {
  events: AuditEventRow[];
  hasMore: boolean;
};

export async function readAuditEvents(
  db: NodePgDatabase<typeof schema>,
  filters: {
    limit: number;
    offset: number;
    eventType?: string;
    actor?: string;
    from?: string;
    to?: string;
  },
): Promise<AuditEventsResult> {
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
        filters.eventType
          ? eq(schema.auditEvents.eventType, filters.eventType)
          : undefined,
        filters.actor
          ? eq(schema.users.username, filters.actor)
          : undefined,
        filters.from
          ? gte(schema.auditEvents.createdAt, new Date(filters.from))
          : undefined,
        filters.to
          ? lte(schema.auditEvents.createdAt, new Date(filters.to))
          : undefined,
      ),
    )
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(filters.limit)
    .offset(filters.offset);
  return { events, hasMore: events.length === filters.limit };
}

export type AuditOptions = {
  eventTypes: string[];
  actors: string[];
};

export async function readAuditOptions(
  db: NodePgDatabase<typeof schema>,
): Promise<AuditOptions> {
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
}

export type AgentTurnRow = {
  turnId: string;
  conversationId: string;
  status: string;
  model: string | null;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export async function readAgentTurns(
  db: NodePgDatabase<typeof schema>,
  limit: number,
): Promise<{ turns: AgentTurnRow[] }> {
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
    .limit(limit);
  return { turns };
}

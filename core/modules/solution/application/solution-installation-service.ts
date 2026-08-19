/**
 * Solution Installation domain service.
 *
 * PostgreSQL is the authoritative fact store. HTTP requests only create
 * commands; the Solution Runner claims operations, executes them, and reports
 * back through complete/fail.
 */
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import {
  canTransitionOperationState,
  intermediateObservedState,
  planOperationTarget,
  type DesiredSolutionState,
  type ObservedSolutionState,
  type SolutionHealthState,
  type SolutionInstallationState,
  type SolutionOperationState,
  type SolutionOperationType,
} from "./solution-installation-state.js";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type SolutionDatabase = Database | Transaction;

function toInstallationState(
  installation: typeof schema.solutionInstallations.$inferSelect,
): SolutionInstallationState {
  return {
    desiredState: installation.desiredState as DesiredSolutionState,
    observedState: installation.observedState as ObservedSolutionState,
    healthState: installation.healthState as SolutionHealthState,
  };
}

export interface CreateSolutionOperationInput {
  solutionId: string;
  type: SolutionOperationType;
  idempotencyKey: string;
  actor: string;
  solutionVersion?: string;
  planDigest?: string;
  manifest?: Record<string, unknown>;
  lock?: Record<string, unknown>;
  signature?: Record<string, unknown>;
}

export interface ClaimSolutionOperationInput {
  operationId: string;
  runnerId: string;
  leaseTtlMs?: number;
}

export interface StartSolutionOperationInput {
  operationId: string;
  runnerId: string;
}

export interface CompleteSolutionOperationInput {
  operationId: string;
  runnerId: string;
  solutionVersion?: string;
  checkpoint?: string;
}

export interface FailSolutionOperationInput {
  operationId: string;
  runnerId: string;
  errorCode: string;
  checkpoint?: string;
}

export interface CheckpointSolutionOperationInput {
  operationId: string;
  runnerId: string;
  checkpoint: string;
}

export type SolutionServiceResult<T> =
  | { status: "ok"; data: T }
  | { status: "invalid_transition"; reason: string }
  | { status: "not_found" }
  | { status: "idempotency_conflict" }
  | { status: "lease_conflict" };

const DEFAULT_LEASE_TTL_MS = 60_000;

async function readInstallation(
  db: SolutionDatabase,
  solutionId: string,
): Promise<typeof schema.solutionInstallations.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(schema.solutionInstallations)
    .where(eq(schema.solutionInstallations.solutionId, solutionId))
    .limit(1);
  return rows[0];
}

async function ensureInstallationRow(
  db: SolutionDatabase,
  solutionId: string,
  version: string,
): Promise<typeof schema.solutionInstallations.$inferSelect> {
  const existing = await readInstallation(db, solutionId);
  if (existing) return existing;
  await db
    .insert(schema.solutionInstallations)
    .values({
      solutionId,
      version,
      desiredState: "disabled",
      observedState: "absent",
      healthState: "unknown",
    })
    .onConflictDoNothing();
  const created = await readInstallation(db, solutionId);
  if (!created) throw new Error("failed to create solution installation row");
  return created;
}

async function recordEvent(
  db: SolutionDatabase,
  input: {
    solutionId: string;
    operationId?: string;
    eventType: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(schema.solutionEvents).values({
    eventId: randomUUID(),
    solutionId: input.solutionId,
    ...(input.operationId === undefined
      ? {}
      : { operationId: input.operationId }),
    eventType: input.eventType,
    payload: input.payload ?? {},
  });
}

export async function createSolutionOperation(
  db: Database,
  input: CreateSolutionOperationInput,
): Promise<
  SolutionServiceResult<typeof schema.solutionOperations.$inferSelect>
> {
  return db.transaction(async (transaction) => {
    const installation =
      input.type === "install"
        ? await ensureInstallationRow(
            transaction,
            input.solutionId,
            input.solutionVersion ?? "0.0.0",
          )
        : await readInstallation(transaction, input.solutionId);
    if (!installation) {
      return { status: "not_found" as const };
    }

    const decision = planOperationTarget(
      input.type,
      toInstallationState(installation),
    );
    if (!decision.allowed) {
      return { status: "invalid_transition", reason: decision.reason };
    }

    const existing = await transaction
      .select({ operationId: schema.solutionOperations.operationId })
      .from(schema.solutionOperations)
      .where(eq(schema.solutionOperations.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (existing[0]) {
      const operation = await getSolutionOperation(
        transaction,
        existing[0].operationId,
      );
      return operation
        ? { status: "ok", data: operation }
        : { status: "idempotency_conflict" };
    }

    if (
      (input.type === "install" || input.type === "upgrade") &&
      (!input.manifest || !input.lock || !input.signature)
    ) {
      return {
        status: "invalid_transition",
        reason: "missing_payload",
      };
    }

    const operationId = randomUUID();
    await transaction.insert(schema.solutionOperations).values({
      operationId,
      solutionId: input.solutionId,
      type: input.type,
      state: "queued",
      idempotencyKey: input.idempotencyKey,
      ...(input.planDigest === undefined
        ? {}
        : { planDigest: input.planDigest }),
      attempt: 0,
      actor: input.actor,
    });
    if (input.manifest && input.lock && input.signature) {
      await transaction.insert(schema.solutionOperationPayloads).values({
        operationId,
        manifestJson: input.manifest,
        lockJson: input.lock,
        signatureJson: input.signature,
      });
    }
    await recordEvent(transaction, {
      solutionId: input.solutionId,
      operationId,
      eventType: "solution.operation_queued",
      payload: { type: input.type },
    });
    const operation = await getSolutionOperation(transaction, operationId);
    if (!operation)
      throw new Error("created solution operation is unavailable");
    return { status: "ok", data: operation };
  });
}

export async function claimSolutionOperation(
  db: Database,
  input: ClaimSolutionOperationInput,
): Promise<
  SolutionServiceResult<typeof schema.solutionOperations.$inferSelect>
> {
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const claimedAt = new Date();
  const leaseUntil = new Date(claimedAt.getTime() + leaseTtlMs);
  const operation = await db.transaction(async (transaction) => {
    const updated = await transaction
      .update(schema.solutionOperations)
      .set({
        state: "claimed",
        claimedAt,
        leaseUntil,
        attempt: sql`${schema.solutionOperations.attempt} + 1`,
        checkpoint: null,
        runnerId: input.runnerId,
      })
      .where(
        and(
          eq(schema.solutionOperations.operationId, input.operationId),
          or(
            eq(schema.solutionOperations.state, "queued"),
            and(
              inArray(schema.solutionOperations.state, ["claimed", "running"]),
              lt(schema.solutionOperations.leaseUntil, claimedAt),
            ),
          ),
        ),
      )
      .returning();
    if (!updated[0]) return undefined;

    const installation = await readInstallation(
      transaction,
      updated[0].solutionId,
    );
    const intermediate = intermediateObservedState(
      updated[0].type as SolutionOperationType,
    );
    if (installation && intermediate) {
      await transaction
        .update(schema.solutionInstallations)
        .set({ observedState: intermediate, updatedAt: new Date() })
        .where(
          eq(schema.solutionInstallations.solutionId, installation.solutionId),
        );
    }
    await recordEvent(transaction, {
      solutionId: updated[0].solutionId,
      operationId: updated[0].operationId,
      eventType: "solution.operation_claimed",
      payload: {
        runnerId: input.runnerId,
        leaseUntil: leaseUntil.toISOString(),
      },
    });
    return updated[0];
  });
  if (!operation) return { status: "lease_conflict" };
  return { status: "ok", data: operation };
}

export async function startSolutionOperation(
  db: Database,
  input: StartSolutionOperationInput,
): Promise<
  SolutionServiceResult<typeof schema.solutionOperations.$inferSelect>
> {
  const operation = await db.transaction(async (transaction) => {
    const updated = await transaction
      .update(schema.solutionOperations)
      .set({ state: "running" })
      .where(
        and(
          eq(schema.solutionOperations.operationId, input.operationId),
          eq(schema.solutionOperations.state, "claimed"),
          eq(schema.solutionOperations.runnerId, input.runnerId),
        ),
      )
      .returning();
    if (!updated[0]) return undefined;
    await recordEvent(transaction, {
      solutionId: updated[0].solutionId,
      operationId: updated[0].operationId,
      eventType: "solution.operation_started",
      payload: { runnerId: input.runnerId },
    });
    return updated[0];
  });
  if (!operation) return { status: "lease_conflict" };
  return { status: "ok", data: operation };
}

export async function completeSolutionOperation(
  db: Database,
  input: CompleteSolutionOperationInput,
): Promise<
  SolutionServiceResult<typeof schema.solutionOperations.$inferSelect>
> {
  return db.transaction(async (transaction) => {
    const current = await getSolutionOperation(transaction, input.operationId);
    if (!current) return { status: "not_found" };
    if (current.runnerId !== input.runnerId) {
      return { status: "lease_conflict" };
    }
    if (
      !canTransitionOperationState(
        current.state as SolutionOperationState,
        "succeeded",
      )
    ) {
      return {
        status: "invalid_transition",
        reason: `operation ${input.operationId} cannot transition to succeeded from ${current.state}`,
      };
    }

    const operationType = current.type as SolutionOperationType;
    const installation = await readInstallation(
      transaction,
      current.solutionId,
    );
    let decision: ReturnType<typeof planOperationTarget> | undefined;
    if (installation) {
      decision = planOperationTarget(
        operationType,
        toInstallationState(installation),
      );
      if (!decision.allowed) {
        await recordEvent(transaction, {
          solutionId: current.solutionId,
          operationId: current.operationId,
          eventType: "solution.operation_target_rejected",
          payload: { reason: decision.reason },
        });
        return { status: "invalid_transition", reason: decision.reason };
      }
    }

    const updated = await transaction
      .update(schema.solutionOperations)
      .set({
        state: "succeeded",
        ...(input.checkpoint === undefined
          ? {}
          : { checkpoint: input.checkpoint }),
      })
      .where(
        and(
          eq(schema.solutionOperations.operationId, input.operationId),
          eq(schema.solutionOperations.state, current.state),
          eq(schema.solutionOperations.runnerId, input.runnerId),
        ),
      )
      .returning();
    if (!updated[0]) return { status: "lease_conflict" };

    const operation = updated[0];
    if (installation && decision?.allowed) {
      const nextVersion = input.solutionVersion ?? installation.version;
      await transaction
        .update(schema.solutionInstallations)
        .set({
          version: nextVersion,
          ...(decision.target.desiredState === undefined
            ? {}
            : { desiredState: decision.target.desiredState }),
          ...(decision.target.observedState === undefined
            ? {}
            : { observedState: decision.target.observedState }),
          ...(decision.target.healthState === undefined
            ? {}
            : { healthState: decision.target.healthState }),
          updatedAt: new Date(),
        })
        .where(
          eq(schema.solutionInstallations.solutionId, operation.solutionId),
        );
      // 安装/升级成功后，把 manifest 声明的 Execution Profiles 同步到
      // agent.execution_profiles，使 Agent Turn 准入与策略解析可用。
      if (operation.type === "install" || operation.type === "upgrade") {
        await syncExecutionProfiles(
          transaction,
          operation.operationId,
          operation.solutionId,
          nextVersion,
        );
      }
    }
    await recordEvent(transaction, {
      solutionId: operation.solutionId,
      operationId: operation.operationId,
      eventType: "solution.operation_succeeded",
      payload: { type: operation.type },
    });
    return { status: "ok", data: operation };
  });
}

/**
 * 把 manifest 声明的 Execution Profiles 同步到 agent.execution_profiles。
 * 安装/升级成功后调用；profile 直接置为 active，使 Agent Turn 准入与
 * 策略解析立即可用。profileId 使用 `${solutionId}/${profile.id}` 避免
 * 不同 Solution 之间的 id 冲突。
 */
async function syncExecutionProfiles(
  db: Transaction,
  operationId: string,
  solutionId: string,
  solutionVersion: string,
): Promise<void> {
  const payloads = await db
    .select({ manifestJson: schema.solutionOperationPayloads.manifestJson })
    .from(schema.solutionOperationPayloads)
    .where(eq(schema.solutionOperationPayloads.operationId, operationId))
    .limit(1);
  const manifest = payloads[0]?.manifestJson;
  if (!manifest || typeof manifest !== "object") return;
  const profiles = (manifest as { executionProfiles?: unknown })
    .executionProfiles;
  if (!Array.isArray(profiles)) return;
  for (const raw of profiles) {
    if (!raw || typeof raw !== "object") continue;
    const profile = raw as {
      id?: unknown;
      strategyRef?: unknown;
      maxModelCalls?: unknown;
      maxToolCalls?: unknown;
      timeoutSeconds?: unknown;
      allowedTools?: unknown;
      skills?: unknown;
    };
    if (typeof profile.id !== "string" || typeof profile.strategyRef !== "string") {
      continue;
    }
    const skills = Array.isArray(profile.skills)
      ? profile.skills.filter(
          (skill): skill is { id: string; version?: string } =>
            typeof skill === "object" &&
            skill !== null &&
            typeof (skill as { id?: unknown }).id === "string",
        )
      : [];
    await db
      .insert(schema.agentExecutionProfiles)
      .values({
        profileId: `${solutionId}/${profile.id}`,
        solutionId,
        solutionVersion,
        strategyRef: profile.strategyRef,
        strategyVersion: solutionVersion,
        maxModelCalls:
          typeof profile.maxModelCalls === "number" ? profile.maxModelCalls : 2,
        maxToolCalls:
          typeof profile.maxToolCalls === "number" ? profile.maxToolCalls : 1,
        timeoutSeconds:
          typeof profile.timeoutSeconds === "number"
            ? profile.timeoutSeconds
            : 60,
        allowedTools: Array.isArray(profile.allowedTools)
          ? profile.allowedTools.filter(
              (tool): tool is string => typeof tool === "string",
            )
          : [],
        skills,
        status: "active",
      })
      .onConflictDoUpdate({
        target: schema.agentExecutionProfiles.profileId,
        set: {
          solutionId,
          solutionVersion,
          strategyRef: profile.strategyRef,
          strategyVersion: solutionVersion,
          maxModelCalls:
            typeof profile.maxModelCalls === "number"
              ? profile.maxModelCalls
              : 2,
          maxToolCalls:
            typeof profile.maxToolCalls === "number" ? profile.maxToolCalls : 1,
          timeoutSeconds:
            typeof profile.timeoutSeconds === "number"
              ? profile.timeoutSeconds
              : 60,
          allowedTools: Array.isArray(profile.allowedTools)
            ? profile.allowedTools.filter(
                (tool): tool is string => typeof tool === "string",
              )
            : [],
          skills,
          status: "active",
          updatedAt: new Date(),
        },
      });
  }
}

export async function failSolutionOperation(
  db: Database,
  input: FailSolutionOperationInput,
): Promise<
  SolutionServiceResult<typeof schema.solutionOperations.$inferSelect>
> {
  return db.transaction(async (transaction) => {
    const current = await getSolutionOperation(transaction, input.operationId);
    if (!current) return { status: "not_found" };
    if (current.runnerId !== input.runnerId) {
      return { status: "lease_conflict" };
    }
    if (
      !canTransitionOperationState(
        current.state as SolutionOperationState,
        "failed",
      )
    ) {
      return {
        status: "invalid_transition",
        reason: `operation ${input.operationId} cannot transition to failed from ${current.state}`,
      };
    }

    const updated = await transaction
      .update(schema.solutionOperations)
      .set({
        state: "failed",
        errorCode: input.errorCode,
        ...(input.checkpoint === undefined
          ? {}
          : { checkpoint: input.checkpoint }),
      })
      .where(
        and(
          eq(schema.solutionOperations.operationId, input.operationId),
          eq(schema.solutionOperations.state, current.state),
          eq(schema.solutionOperations.runnerId, input.runnerId),
        ),
      )
      .returning();
    if (!updated[0]) return { status: "lease_conflict" };

    const operation = updated[0];
    await transaction
      .update(schema.solutionInstallations)
      .set({
        observedState: "failed",
        healthState: "unhealthy",
        updatedAt: new Date(),
      })
      .where(eq(schema.solutionInstallations.solutionId, operation.solutionId));
    await recordEvent(transaction, {
      solutionId: operation.solutionId,
      operationId: operation.operationId,
      eventType: "solution.operation_failed",
      payload: { errorCode: input.errorCode },
    });
    return { status: "ok", data: operation };
  });
}

export async function listSolutionInstallations(db: Database) {
  return db.select().from(schema.solutionInstallations);
}

export async function listConsoleExtensions(db: Database): Promise<
  Array<{
    solutionId: string;
    version: string;
    extensions: Array<Record<string, unknown>>;
  }>
> {
  const installations = await db
    .select()
    .from(schema.solutionInstallations)
    .where(
      inArray(schema.solutionInstallations.observedState, [
        "installed",
        "configured",
        "active",
        "degraded",
      ]),
    );
  const result: Array<{
    solutionId: string;
    version: string;
    extensions: Array<Record<string, unknown>>;
  }> = [];
  for (const installation of installations) {
    const operationRows = await db
      .select({ operationId: schema.solutionOperations.operationId })
      .from(schema.solutionOperations)
      .where(
        and(
          eq(schema.solutionOperations.solutionId, installation.solutionId),
          inArray(schema.solutionOperations.type, ["install", "upgrade"]),
          eq(schema.solutionOperations.state, "succeeded"),
        ),
      )
      .orderBy(desc(schema.solutionOperations.createdAt))
      .limit(1);
    const operationId = operationRows[0]?.operationId;
    if (!operationId) continue;
    const payloadRows = await db
      .select({ manifestJson: schema.solutionOperationPayloads.manifestJson })
      .from(schema.solutionOperationPayloads)
      .where(eq(schema.solutionOperationPayloads.operationId, operationId))
      .limit(1);
    const manifest = payloadRows[0]?.manifestJson as
      { consoleExtensions?: unknown } | undefined;
    const extensions = Array.isArray(manifest?.consoleExtensions)
      ? (manifest.consoleExtensions as Array<Record<string, unknown>>)
      : [];
    if (extensions.length > 0) {
      result.push({
        solutionId: installation.solutionId,
        version: installation.version,
        extensions,
      });
    }
  }
  return result;
}

export async function listDashboardContributions(db: Database): Promise<
  Array<{
    solutionId: string;
    version: string;
    contributions: Array<Record<string, unknown>>;
  }>
> {
  const installations = await db
    .select()
    .from(schema.solutionInstallations)
    .where(
      inArray(schema.solutionInstallations.observedState, [
        "installed",
        "configured",
        "active",
        "degraded",
      ]),
    );
  const result: Array<{
    solutionId: string;
    version: string;
    contributions: Array<Record<string, unknown>>;
  }> = [];
  for (const installation of installations) {
    const operationRows = await db
      .select({ operationId: schema.solutionOperations.operationId })
      .from(schema.solutionOperations)
      .where(
        and(
          eq(schema.solutionOperations.solutionId, installation.solutionId),
          inArray(schema.solutionOperations.type, ["install", "upgrade"]),
          eq(schema.solutionOperations.state, "succeeded"),
        ),
      )
      .orderBy(desc(schema.solutionOperations.createdAt))
      .limit(1);
    const operationId = operationRows[0]?.operationId;
    if (!operationId) continue;
    const payloadRows = await db
      .select({ manifestJson: schema.solutionOperationPayloads.manifestJson })
      .from(schema.solutionOperationPayloads)
      .where(eq(schema.solutionOperationPayloads.operationId, operationId))
      .limit(1);
    const manifest = payloadRows[0]?.manifestJson as
      | { consoleExtensions?: Array<{ dashboardContributions?: unknown }> }
      | undefined;
    const contributions = (manifest?.consoleExtensions ?? []).flatMap(
      (extension) =>
        Array.isArray(extension.dashboardContributions)
          ? (extension.dashboardContributions as Array<Record<string, unknown>>)
          : [],
    );
    if (contributions.length > 0) {
      result.push({
        solutionId: installation.solutionId,
        version: installation.version,
        contributions,
      });
    }
  }
  return result;
}

export async function listPluginApiRoutes(db: Database): Promise<
  Array<{
    pluginId: string;
    routes: Array<{ prefix: string; target: string }>;
  }>
> {
  const installations = await db
    .select()
    .from(schema.solutionInstallations)
    .where(
      inArray(schema.solutionInstallations.observedState, [
        "installed",
        "configured",
        "active",
        "degraded",
      ]),
    );
  const result: Array<{
    pluginId: string;
    routes: Array<{ prefix: string; target: string }>;
  }> = [];
  for (const installation of installations) {
    const operationRows = await db
      .select({ operationId: schema.solutionOperations.operationId })
      .from(schema.solutionOperations)
      .where(
        and(
          eq(schema.solutionOperations.solutionId, installation.solutionId),
          inArray(schema.solutionOperations.type, ["install", "upgrade"]),
          eq(schema.solutionOperations.state, "succeeded"),
        ),
      )
      .orderBy(desc(schema.solutionOperations.createdAt))
      .limit(1);
    const operationId = operationRows[0]?.operationId;
    if (!operationId) continue;
    const payloadRows = await db
      .select({ manifestJson: schema.solutionOperationPayloads.manifestJson })
      .from(schema.solutionOperationPayloads)
      .where(eq(schema.solutionOperationPayloads.operationId, operationId))
      .limit(1);
    const manifest = payloadRows[0]?.manifestJson as
      { consoleExtensions?: Array<{ apiRoutes?: unknown }> } | undefined;
    const routes = (manifest?.consoleExtensions ?? []).flatMap((extension) =>
      Array.isArray(extension.apiRoutes)
        ? (extension.apiRoutes as Array<{ prefix: string; target: string }>)
        : [],
    );
    if (routes.length > 0) {
      result.push({ pluginId: installation.solutionId, routes });
    }
  }
  return result;
}

export async function listEventSubscriptions(db: Database): Promise<
  Array<{
    pluginId: string;
    events: string[];
    routes: Array<{ prefix: string; target: string }>;
  }>
> {
  const installations = await db
    .select()
    .from(schema.solutionInstallations)
    .where(
      inArray(schema.solutionInstallations.observedState, [
        "installed",
        "configured",
        "active",
        "degraded",
      ]),
    );
  const result: Array<{
    pluginId: string;
    events: string[];
    routes: Array<{ prefix: string; target: string }>;
  }> = [];
  for (const installation of installations) {
    const operationRows = await db
      .select({ operationId: schema.solutionOperations.operationId })
      .from(schema.solutionOperations)
      .where(
        and(
          eq(schema.solutionOperations.solutionId, installation.solutionId),
          inArray(schema.solutionOperations.type, ["install", "upgrade"]),
          eq(schema.solutionOperations.state, "succeeded"),
        ),
      )
      .orderBy(desc(schema.solutionOperations.createdAt))
      .limit(1);
    const operationId = operationRows[0]?.operationId;
    if (!operationId) continue;
    const payloadRows = await db
      .select({ manifestJson: schema.solutionOperationPayloads.manifestJson })
      .from(schema.solutionOperationPayloads)
      .where(eq(schema.solutionOperationPayloads.operationId, operationId))
      .limit(1);
    const manifest = payloadRows[0]?.manifestJson as
      | {
          consoleExtensions?: Array<{
            eventSubscriptions?: unknown;
            apiRoutes?: unknown;
          }>;
        }
      | undefined;
    const events = (manifest?.consoleExtensions ?? []).flatMap((extension) =>
      Array.isArray(extension.eventSubscriptions)
        ? (extension.eventSubscriptions as string[])
        : [],
    );
    const routes = (manifest?.consoleExtensions ?? []).flatMap((extension) =>
      Array.isArray(extension.apiRoutes)
        ? (extension.apiRoutes as Array<{ prefix: string; target: string }>)
        : [],
    );
    if (events.length > 0 && routes.length > 0) {
      result.push({
        pluginId: installation.solutionId,
        events,
        routes,
      });
    }
  }
  return result;
}

export async function listSolutionBackends(
  db: Database,
): Promise<Array<{ solutionId: string; entry: string }>> {
  const installations = await db
    .select()
    .from(schema.solutionInstallations)
    .where(
      inArray(schema.solutionInstallations.observedState, [
        "installed",
        "configured",
        "active",
        "degraded",
      ]),
    );
  const result: Array<{ solutionId: string; entry: string }> = [];
  for (const installation of installations) {
    const operationRows = await db
      .select({ operationId: schema.solutionOperations.operationId })
      .from(schema.solutionOperations)
      .where(
        and(
          eq(schema.solutionOperations.solutionId, installation.solutionId),
          inArray(schema.solutionOperations.type, ["install", "upgrade"]),
          eq(schema.solutionOperations.state, "succeeded"),
        ),
      )
      .orderBy(desc(schema.solutionOperations.createdAt))
      .limit(1);
    const operationId = operationRows[0]?.operationId;
    if (!operationId) continue;
    const payloadRows = await db
      .select({ manifestJson: schema.solutionOperationPayloads.manifestJson })
      .from(schema.solutionOperationPayloads)
      .where(eq(schema.solutionOperationPayloads.operationId, operationId))
      .limit(1);
    const manifest = payloadRows[0]?.manifestJson as
      { backend?: { entry?: unknown } } | undefined;
    const entry = manifest?.backend?.entry;
    if (typeof entry === "string" && entry.length > 0) {
      result.push({ solutionId: installation.solutionId, entry });
    }
  }
  return result;
}

export async function getExtensionSettings(
  db: Database,
  solutionId: string,
  extensionId: string,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select({ settingsJson: schema.solutionExtensionSettings.settingsJson })
    .from(schema.solutionExtensionSettings)
    .where(
      and(
        eq(schema.solutionExtensionSettings.solutionId, solutionId),
        eq(schema.solutionExtensionSettings.extensionId, extensionId),
      ),
    )
    .limit(1);
  return rows[0]?.settingsJson ?? {};
}

export async function saveExtensionSettings(
  db: Database,
  solutionId: string,
  extensionId: string,
  settings: Record<string, unknown>,
  actor: string,
): Promise<Record<string, unknown>> {
  await db
    .insert(schema.solutionExtensionSettings)
    .values({
      solutionId,
      extensionId,
      settingsJson: settings,
      updatedBy: actor,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.solutionExtensionSettings.solutionId,
        schema.solutionExtensionSettings.extensionId,
      ],
      set: {
        settingsJson: settings,
        updatedBy: actor,
        updatedAt: new Date(),
      },
    });
  return settings;
}

export async function listClaimableSolutionOperations(db: Database) {
  return db
    .select()
    .from(schema.solutionOperations)
    .where(eq(schema.solutionOperations.state, "queued"))
    .orderBy(asc(schema.solutionOperations.createdAt))
    .limit(20);
}

export async function listSolutionOperations(
  db: Database,
  solutionId?: string,
) {
  const query = db
    .select()
    .from(schema.solutionOperations)
    .orderBy(desc(schema.solutionOperations.createdAt))
    .limit(50);
  return solutionId
    ? query.where(eq(schema.solutionOperations.solutionId, solutionId))
    : query;
}

export async function getSolutionDetail(db: Database, solutionId: string) {
  const installation = await getSolutionInstallation(db, solutionId);
  if (!installation) return undefined;
  const recentOperations = await listSolutionOperations(db, solutionId);
  return { installation, recentOperations };
}

export async function getSolutionInstallation(
  db: SolutionDatabase,
  solutionId: string,
) {
  const rows = await db
    .select()
    .from(schema.solutionInstallations)
    .where(eq(schema.solutionInstallations.solutionId, solutionId))
    .limit(1);
  return rows[0];
}

export async function getSolutionOperation(
  db: SolutionDatabase,
  operationId: string,
) {
  const rows = await db
    .select()
    .from(schema.solutionOperations)
    .where(eq(schema.solutionOperations.operationId, operationId))
    .limit(1);
  return rows[0];
}

export async function getSolutionOperationPayload(
  db: SolutionDatabase,
  operationId: string,
) {
  const rows = await db
    .select()
    .from(schema.solutionOperationPayloads)
    .where(eq(schema.solutionOperationPayloads.operationId, operationId))
    .limit(1);
  return rows[0];
}

export interface SetSecretAssignmentInput {
  solutionId: string;
  slotName: string;
  refType: "env" | "file";
  refValue: string;
}

export async function listSecretAssignments(db: Database, solutionId: string) {
  return db
    .select()
    .from(schema.solutionSecretAssignments)
    .where(eq(schema.solutionSecretAssignments.solutionId, solutionId));
}

export async function getSolutionSecretStatus(
  db: Database,
  solutionId: string,
) {
  const assignments = await listSecretAssignments(db, solutionId);
  const assignmentBySlot = new Map(
    assignments.map((assignment) => [assignment.slotName, assignment]),
  );

  const latestSucceeded = await db
    .select({ operationId: schema.solutionOperations.operationId })
    .from(schema.solutionOperations)
    .where(
      and(
        eq(schema.solutionOperations.solutionId, solutionId),
        inArray(schema.solutionOperations.type, ["install", "upgrade"]),
        eq(schema.solutionOperations.state, "succeeded"),
      ),
    )
    .orderBy(desc(schema.solutionOperations.createdAt))
    .limit(1);

  let slots: Array<{
    name: string;
    kind: string;
    required: boolean;
    configured: boolean;
    refType?: string;
    refValue?: string;
  }>;
  if (latestSucceeded[0]) {
    const payload = await db
      .select()
      .from(schema.solutionOperationPayloads)
      .where(
        eq(
          schema.solutionOperationPayloads.operationId,
          latestSucceeded[0].operationId,
        ),
      )
      .limit(1);
    const manifest = payload[0]?.manifestJson as
      | {
          secretSlots?: Array<{
            name: string;
            kind: string;
            required: boolean;
          }>;
        }
      | undefined;
    slots = (manifest?.secretSlots ?? []).map((slot) => {
      const assignment = assignmentBySlot.get(slot.name);
      return {
        name: slot.name,
        kind: slot.kind,
        required: slot.required,
        configured: Boolean(assignment),
        ...(assignment
          ? { refType: assignment.refType, refValue: assignment.refValue }
          : {}),
      };
    });
  } else {
    slots = assignments.map((assignment) => ({
      name: assignment.slotName,
      kind: "env",
      required: false,
      configured: true,
      refType: assignment.refType,
      refValue: assignment.refValue,
    }));
  }
  return { slots };
}

export async function setSecretAssignment(
  db: Database,
  input: SetSecretAssignmentInput,
) {
  await db
    .insert(schema.solutionSecretAssignments)
    .values({
      solutionId: input.solutionId,
      slotName: input.slotName,
      refType: input.refType,
      refValue: input.refValue,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.solutionSecretAssignments.solutionId,
        schema.solutionSecretAssignments.slotName,
      ],
      set: {
        refType: input.refType,
        refValue: input.refValue,
        updatedAt: new Date(),
      },
    });
}

export async function deleteSecretAssignment(
  db: Database,
  solutionId: string,
  slotName: string,
) {
  await db
    .delete(schema.solutionSecretAssignments)
    .where(
      and(
        eq(schema.solutionSecretAssignments.solutionId, solutionId),
        eq(schema.solutionSecretAssignments.slotName, slotName),
      ),
    );
}

export async function updateSolutionOperationCheckpoint(
  db: Database,
  input: CheckpointSolutionOperationInput,
): Promise<
  SolutionServiceResult<typeof schema.solutionOperations.$inferSelect>
> {
  return db.transaction(async (transaction) => {
    const current = await getSolutionOperation(transaction, input.operationId);
    if (!current) return { status: "not_found" };
    if (current.runnerId !== input.runnerId) {
      return { status: "lease_conflict" };
    }
    if (current.state !== "claimed" && current.state !== "running") {
      return {
        status: "invalid_transition",
        reason: `checkpoint requires claimed or running state, got ${current.state}`,
      };
    }

    const updated = await transaction
      .update(schema.solutionOperations)
      .set({ checkpoint: input.checkpoint })
      .where(
        and(
          eq(schema.solutionOperations.operationId, input.operationId),
          eq(schema.solutionOperations.runnerId, input.runnerId),
          inArray(schema.solutionOperations.state, ["claimed", "running"]),
        ),
      )
      .returning();
    if (!updated[0]) return { status: "lease_conflict" };

    await recordEvent(transaction, {
      solutionId: updated[0].solutionId,
      operationId: updated[0].operationId,
      eventType: "solution.operation_checkpoint",
      payload: { checkpoint: input.checkpoint },
    });
    return { status: "ok", data: updated[0] };
  });
}

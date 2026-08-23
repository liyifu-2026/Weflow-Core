import { and, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

type Database = NodePgDatabase<typeof schema>;

type DeclaredHealthCheck = {
  id: string;
  name?: string;
  type: string;
  target: string;
  port?: number;
  timeoutSeconds?: number;
};

export type SolutionHealthCheckResult = {
  id: string;
  name: string;
  type: string;
  target: string;
  port?: number;
  status: "healthy" | "unreachable" | "not_configured";
  summary: string;
  checkedAt: string;
};

export type SolutionHealthSummary = {
  solutionId: string;
  version: string;
  observedState: string;
  checks: SolutionHealthCheckResult[];
};

async function latestManifest(
  db: Database,
  solutionId: string,
): Promise<Record<string, unknown> | undefined> {
  const operationRows = await db
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
  const operationId = operationRows[0]?.operationId;
  if (!operationId) return undefined;
  const payloadRows = await db
    .select({ manifestJson: schema.solutionOperationPayloads.manifestJson })
    .from(schema.solutionOperationPayloads)
    .where(eq(schema.solutionOperationPayloads.operationId, operationId))
    .limit(1);
  return payloadRows[0]?.manifestJson as Record<string, unknown> | undefined;
}

async function probeCheck(
  check: DeclaredHealthCheck,
): Promise<SolutionHealthCheckResult> {
  const checkedAt = new Date().toISOString();
  const timeoutMs = Math.max(1000, (check.timeoutSeconds ?? 5) * 1000);
  const name = check.name || check.id;
  if (check.type === "http") {
    try {
      const response = await fetch(check.target, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        return {
          id: check.id,
          name,
          type: check.type,
          target: check.target,
          ...(check.port === undefined ? {} : { port: check.port }),
          status: "healthy",
          summary: `HTTP ${response.status}`,
          checkedAt,
        };
      }
      return {
        id: check.id,
        name,
        type: check.type,
        target: check.target,
        ...(check.port === undefined ? {} : { port: check.port }),
        status: "unreachable",
        summary: `HTTP ${response.status}`,
        checkedAt,
      };
    } catch {
      return {
        id: check.id,
        name,
        type: check.type,
        target: check.target,
        ...(check.port === undefined ? {} : { port: check.port }),
        status: "unreachable",
        summary: "连接失败或超时",
        checkedAt,
      };
    }
  }
  return {
    id: check.id,
    name,
    type: check.type,
    target: check.target,
    ...(check.port === undefined ? {} : { port: check.port }),
    status: "not_configured",
    summary: "暂不支持该检测类型",
    checkedAt,
  };
}

export async function listSolutionHealth(
  db: Database,
): Promise<SolutionHealthSummary[]> {
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

  const result: SolutionHealthSummary[] = [];
  for (const installation of installations) {
    const manifest = await latestManifest(db, installation.solutionId);
    const rawChecks = Array.isArray(manifest?.healthChecks)
      ? (manifest.healthChecks as DeclaredHealthCheck[])
      : [];
    const checks = await Promise.all(rawChecks.map((check) => probeCheck(check)));
    result.push({
      solutionId: installation.solutionId,
      version: installation.version,
      observedState: installation.observedState,
      checks,
    });
  }
  return result;
}

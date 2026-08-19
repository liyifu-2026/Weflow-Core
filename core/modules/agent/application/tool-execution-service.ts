import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

type Database = NodePgDatabase<typeof schema>;
type ToolResult = Record<string, unknown>;

export type ToolExecutionRecord = typeof schema.toolExecutions.$inferSelect;

export const TOOL_EXECUTION_LEASE_MS = 5 * 60_000;

export type ToolExecutionClaim =
  | { status: "claimed"; execution: ToolExecutionRecord }
  | { status: "already_completed"; result: ToolResult }
  | {
      status: "not_claimable";
      errorCode: "tool_not_plannable" | "tool_execution_owned";
      currentStatus?: string;
    };

export type ToolExecutionCompletion =
  | { status: "succeeded"; result: ToolResult }
  | { status: "already_completed"; result: ToolResult }
  | { status: "failed"; errorCode: string }
  | { status: "not_claimable"; errorCode: string };

/** Owns the persisted lifecycle of one ToolExecution. */
export class ToolExecutionService {
  public constructor(private readonly db: Database) {}

  /** Atomically claims planned or expired work, or reuses an existing success. */
  public async claim(executionId: string): Promise<ToolExecutionClaim> {
    return this.db.transaction(async (transaction) => {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - TOOL_EXECUTION_LEASE_MS);
      const claimed = await transaction
        .update(schema.toolExecutions)
        .set({
          status: "running",
          attempt: sql`${schema.toolExecutions.attempt} + 1`,
          claimedAt: now,
          leaseUntil: new Date(now.getTime() + TOOL_EXECUTION_LEASE_MS),
          errorCode: null,
        })
        .where(
          and(
            eq(schema.toolExecutions.executionId, executionId),
            or(
              eq(schema.toolExecutions.status, "planned"),
              and(
                eq(schema.toolExecutions.status, "running"),
                or(
                  lt(schema.toolExecutions.leaseUntil, now),
                  and(
                    isNull(schema.toolExecutions.leaseUntil),
                    sql`EXISTS (
                      SELECT 1
                      FROM agent.turns t
                      WHERE t.turn_id = ${schema.toolExecutions.turnId}
                        AND t.started_at < ${staleBefore}
                    )`,
                  ),
                ),
              ),
            ),
          ),
        )
        .returning();
      const execution = claimed[0];
      if (execution) return { status: "claimed", execution };

      const existing = await transaction
        .select({
          status: schema.toolExecutions.status,
          result: schema.toolExecutions.result,
        })
        .from(schema.toolExecutions)
        .where(eq(schema.toolExecutions.executionId, executionId))
        .limit(1);
      if (existing[0]?.status === "succeeded") {
        return {
          status: "already_completed",
          result: existing[0].result ?? {},
        };
      }
      return {
        status: "not_claimable",
        errorCode:
          existing[0]?.status === "running"
            ? "tool_execution_owned"
            : "tool_not_plannable",
        ...(existing[0]?.status ? { currentStatus: existing[0].status } : {}),
      };
    });
  }

  /** Persists success only when this worker still owns running work. */
  public async complete(
    executionId: string,
    result: ToolResult,
    claimedAt?: Date | null,
  ): Promise<ToolExecutionCompletion> {
    return this.db.transaction(async (transaction) => {
      const completed = await transaction
        .update(schema.toolExecutions)
        .set({
          status: "succeeded",
          result,
          completedAt: new Date(),
          claimedAt: null,
          leaseUntil: null,
        })
        .where(
          and(
            eq(schema.toolExecutions.executionId, executionId),
            eq(schema.toolExecutions.status, "running"),
            ...(claimedAt === undefined
              ? []
              : [
                  claimedAt === null
                    ? isNull(schema.toolExecutions.claimedAt)
                    : eq(schema.toolExecutions.claimedAt, claimedAt),
                ]),
          ),
        )
        .returning({ result: schema.toolExecutions.result });
      if (completed[0]) {
        return { status: "succeeded", result: completed[0].result ?? result };
      }
      const existing = await transaction
        .select({
          status: schema.toolExecutions.status,
          result: schema.toolExecutions.result,
          errorCode: schema.toolExecutions.errorCode,
        })
        .from(schema.toolExecutions)
        .where(eq(schema.toolExecutions.executionId, executionId))
        .limit(1);
      if (existing[0]?.status === "succeeded") {
        return {
          status: "already_completed",
          result: existing[0].result ?? {},
        };
      }
      if (existing[0]?.status === "running" && claimedAt !== undefined) {
        return { status: "not_claimable", errorCode: "tool_lease_lost" };
      }
      return {
        status: "failed",
        errorCode: existing[0]?.errorCode ?? "tool_not_plannable",
      };
    });
  }

  /** Persists failure only when this worker still owns running work. */
  public async fail(
    executionId: string,
    errorCode: string,
    claimedAt?: Date | null,
  ): Promise<ToolExecutionCompletion> {
    return this.db.transaction(async (transaction) => {
      const failed = await transaction
        .update(schema.toolExecutions)
        .set({
          status: "failed",
          errorCode,
          completedAt: new Date(),
          claimedAt: null,
          leaseUntil: null,
        })
        .where(
          and(
            eq(schema.toolExecutions.executionId, executionId),
            eq(schema.toolExecutions.status, "running"),
            ...(claimedAt === undefined
              ? []
              : [
                  claimedAt === null
                    ? isNull(schema.toolExecutions.claimedAt)
                    : eq(schema.toolExecutions.claimedAt, claimedAt),
                ]),
          ),
        )
        .returning({ errorCode: schema.toolExecutions.errorCode });
      if (failed[0]) {
        return {
          status: "failed",
          errorCode: failed[0].errorCode ?? errorCode,
        };
      }
      const existing = await transaction
        .select({
          status: schema.toolExecutions.status,
          result: schema.toolExecutions.result,
          errorCode: schema.toolExecutions.errorCode,
        })
        .from(schema.toolExecutions)
        .where(eq(schema.toolExecutions.executionId, executionId))
        .limit(1);
      if (existing[0]?.status === "succeeded") {
        return {
          status: "already_completed",
          result: existing[0].result ?? {},
        };
      }
      if (existing[0]?.status === "running" && claimedAt !== undefined) {
        return { status: "not_claimable", errorCode: "tool_lease_lost" };
      }
      return {
        status: "failed",
        errorCode: existing[0]?.errorCode ?? errorCode,
      };
    });
  }

  /** Returns only a persisted successful snapshot. */
  public async getCompletedResult(
    executionId: string,
  ): Promise<ToolResult | undefined> {
    const rows = await this.db
      .select({
        status: schema.toolExecutions.status,
        result: schema.toolExecutions.result,
      })
      .from(schema.toolExecutions)
      .where(eq(schema.toolExecutions.executionId, executionId))
      .limit(1);
    return rows[0]?.status === "succeeded" ? (rows[0].result ?? {}) : undefined;
  }
}

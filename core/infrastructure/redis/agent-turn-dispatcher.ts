/**
 * Agent 轮次分发器
 * 从 PostgreSQL 读取 queued 状态的 Agent 轮次，合并后推入 Redis 队列
 * 核心逻辑：
 * - 排除有运行中轮次或待回复消息的会话
 * - 同一会话的多个排队轮次只保留最新的（静默窗口机制）
 * - 使用 SHA256 生成稳定的队列 Job ID
 */
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../postgres/schema.js";
import { createJobQueue, type JobEnvelope } from "./job-queue.js";

/** Agent 轮次队列名称 */
export const AGENT_TURN_QUEUE = "agent-turns";

/** 分发器配置选项 */
type DispatcherOptions = {
  db: NodePgDatabase<typeof schema>;
  redisUrl: string;
  logger: Logger;
  intervalMs?: number;
  now?: () => Date;
};

/** 静默窗口时间（毫秒），在此窗口内的多个轮次会被合并 */
export const AGENT_TURN_QUIET_WINDOW_MS = 3_000;

/**
 * 待发送 Agent 回复的排除窗口（毫秒）。
 * dispatcher 会跳过存在"最近窗口内"未确认 Agent 回复的会话，
 * 避免与正在发出的回复叠加；超过窗口的 pending/unknown 消息视为
 * 渠道确认丢失的死消息，不再阻塞该会话的新轮次。
 */
export const AGENT_PENDING_REPLY_WINDOW_MS = 10 * 60_000;

/** 运行中或工具待执行轮次被视为崩溃失效的时长阈值（毫秒）。 */
export const STALE_RUNNING_TURN_MS = 5 * 60_000;

/** 排队中的 Agent 轮次 */
export type QueuedAgentTurn = {
  turnId: string;
  conversationId: string;
  traceId: string;
  createdAt: Date;
};

/**
 * 合并排队的 Agent 轮次
 * 同一会话只保留最新轮次，旧轮次标记为 superseded
 * 仅当最新轮次超过静默窗口后才标记为 ready
 */
export function coalesceQueuedAgentTurns(
  turns: QueuedAgentTurn[],
  now: Date,
  quietWindowMs = AGENT_TURN_QUIET_WINDOW_MS,
): { ready: QueuedAgentTurn[]; superseded: QueuedAgentTurn[] } {
  const byConversation = new Map<string, QueuedAgentTurn[]>();
  for (const turn of turns) {
    const conversationTurns = byConversation.get(turn.conversationId) ?? [];
    conversationTurns.push(turn);
    byConversation.set(turn.conversationId, conversationTurns);
  }

  const ready: QueuedAgentTurn[] = [];
  const superseded: QueuedAgentTurn[] = [];
  for (const conversationTurns of byConversation.values()) {
    conversationTurns.sort(compareTurns);
    const latest = conversationTurns.at(-1);
    if (!latest) continue;
    superseded.push(...conversationTurns.slice(0, -1));
    if (now.getTime() - latest.createdAt.getTime() >= quietWindowMs) {
      ready.push(latest);
    }
  }
  ready.sort(compareTurns);
  return { ready, superseded };
}

/** 启动 Agent 轮次分发器 */
export function startAgentTurnDispatcher(
  options: DispatcherOptions,
): () => void {
  const queue = createJobQueue(AGENT_TURN_QUEUE, options.redisUrl);
  const abortController = new AbortController();

  const run = async (): Promise<void> => {
    while (!abortController.signal.aborted) {
      try {
        // 恢复 worker 崩溃后的 Agent Turn：running 重置为 queued；
        // 已持久化的工具阶段回到 queued，由 AgentTurnExecutor 继续执行。
        const staleBefore = new Date(
          (options.now?.() ?? new Date()).getTime() - STALE_RUNNING_TURN_MS,
        );
        const recoveredToolTurns = await recoverStalePlannedTurns(
          options.db,
          options.now?.() ?? new Date(),
        );
        const recovered = await resetStaleRunningTurns(options.db, staleBefore);
        for (const turnId of recovered) {
          await queue.remove(queueJobIdForTurn(turnId));
        }
        for (const turnId of recoveredToolTurns) {
          await queue.remove(queueJobIdForTurn(turnId));
        }
        // A running turn is intentionally left alone. Its conversation is
        // excluded until it completes, then the newest queued turn is
        // coalesced using the quiet window below.
        const runningTurns = alias(schema.agentTurns, "running_agent_turns");
        const pendingReplies = alias(schema.messages, "pending_agent_replies");
        const pendingReplySince = new Date(
          (options.now?.() ?? new Date()).getTime() -
            AGENT_PENDING_REPLY_WINDOW_MS,
        );
        const turns = await options.db
          .select({
            turnId: schema.agentTurns.turnId,
            conversationId: schema.agentTurns.conversationId,
            traceId: schema.agentTurns.traceId,
            createdAt: schema.agentTurns.createdAt,
          })
          .from(schema.agentTurns)
          .where(
            and(
              eq(schema.agentTurns.status, "queued"),
              notExists(
                options.db
                  .select({ one: sql<number>`1` })
                  .from(runningTurns)
                  .where(
                    and(
                      eq(
                        runningTurns.conversationId,
                        schema.agentTurns.conversationId,
                      ),
                      eq(runningTurns.status, "running"),
                    ),
                  ),
              ),
              notExists(
                options.db
                  .select({ one: sql<number>`1` })
                  .from(pendingReplies)
                  .where(
                    and(
                      eq(
                        pendingReplies.conversationId,
                        schema.agentTurns.conversationId,
                      ),
                      eq(pendingReplies.actorType, "agent"),
                      inArray(pendingReplies.sendState, [
                        "pending",
                        "submitting",
                        "unknown",
                      ]),
                      // 只排除最近窗口内的待确认回复；过期消息视为
                      // 渠道确认丢失，不再阻塞新轮次
                      gt(pendingReplies.occurredAt, pendingReplySince),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(
            asc(schema.agentTurns.createdAt),
            asc(schema.agentTurns.turnId),
          )
          .limit(1_000);
        const coalesced = coalesceQueuedAgentTurns(
          turns,
          options.now?.() ?? new Date(),
        );
        if (coalesced.superseded.length > 0) {
          await options.db
            .update(schema.agentTurns)
            .set({ status: "superseded", errorCode: "coalesced_quiet_window" })
            .where(
              and(
                eq(schema.agentTurns.status, "queued"),
                inArray(
                  schema.agentTurns.turnId,
                  coalesced.superseded.map((turn) => turn.turnId),
                ),
              ),
            );
        }
        for (const turn of coalesced.ready) {
          const queueJobId = queueJobIdForTurn(turn.turnId);
          const envelope: JobEnvelope = {
            jobId: queueJobId,
            jobType: "agent.turn",
            ownerModule: "agent",
            businessEntityId: turn.turnId,
            idempotencyKey: turn.turnId,
            attempt: 0,
            traceId: turn.traceId,
            createdAt: turn.createdAt.toISOString(),
          };
          await queue.add("agent.turn", envelope, { jobId: queueJobId });
        }
      } catch (error) {
        options.logger.error({ err: error }, "Agent turn dispatch failed");
      }
      await wait(options.intervalMs ?? 1_000, abortController.signal);
    }
  };

  void run();
  return () => {
    abortController.abort();
    void queue.close();
  };
}

/** 为轮次生成稳定的队列 Job ID（基于 turnId 的 SHA256 哈希） */
export function queueJobIdForTurn(turnId: string): string {
  return `agent_${createHash("sha256").update(turnId).digest("hex")}`;
}

/**
 * 将运行超过阈值的轮次重置为 queued。
 * 用于恢复 worker 进程崩溃后卡在 running 的轮次；返回被重置的轮次 ID。
 */
export async function resetStaleRunningTurns(
  db: NodePgDatabase<typeof schema>,
  staleBefore: Date,
  conversationId?: string,
): Promise<string[]> {
  const conditions = [
    eq(schema.agentTurns.status, "running"),
    lt(schema.agentTurns.startedAt, staleBefore),
  ];
  if (conversationId) {
    conditions.push(eq(schema.agentTurns.conversationId, conversationId));
  }
  const rows = await db
    .update(schema.agentTurns)
    .set({ status: "queued", startedAt: null, errorCode: null })
    .where(and(...conditions))
    .returning({ turnId: schema.agentTurns.turnId });
  return rows.map((row) => row.turnId);
}

/**
 * 恢复已持久化的工具阶段。
 *
 * ToolExecution 的 lease 是跨进程恢复的权威。只有租约过期的 running
 * execution 会被重新置为 planned；关联的 tool_planned Turn 重新排队，
 * AgentTurnExecutor 会复用 succeeded 结果或继续执行 planned 工具。
 */
export async function recoverStalePlannedTurns(
  db: NodePgDatabase<typeof schema>,
  now: Date,
): Promise<string[]> {
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_TURN_MS);
  const reclaimed = await db
    .update(schema.toolExecutions)
    .set({
      status: "planned",
      claimedAt: null,
      leaseUntil: null,
      errorCode: "tool_execution_lease_expired",
    })
    .where(
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
    )
    .returning({ executionId: schema.toolExecutions.executionId });

  const resumableTurns = await db
    .select({
      turnId: schema.agentTurns.turnId,
      conversationId: schema.agentTurns.conversationId,
    })
    .from(schema.agentTurns)
    .innerJoin(
      schema.toolExecutions,
      eq(schema.toolExecutions.turnId, schema.agentTurns.turnId),
    )
    .where(
      and(
        inArray(schema.agentTurns.status, ["tool_planned", "running"]),
        or(
          lt(schema.agentTurns.startedAt, staleBefore),
          reclaimed.length > 0
            ? inArray(
                schema.toolExecutions.executionId,
                reclaimed.map((row) => row.executionId),
              )
            : sql`FALSE`,
        ),
        or(
          eq(schema.toolExecutions.status, "planned"),
          eq(schema.toolExecutions.status, "succeeded"),
        ),
      ),
    );
  const turnIds = [...new Set(resumableTurns.map((row) => row.turnId))];
  if (turnIds.length > 0) {
    await db
      .update(schema.agentTurns)
      .set({ status: "queued", errorCode: "execution_resumed" })
      .where(
        and(
          inArray(schema.agentTurns.status, ["tool_planned", "running"]),
          inArray(schema.agentTurns.turnId, turnIds),
        ),
      );
    for (const turnId of turnIds) {
      const conversationId = resumableTurns.find(
        (row) => row.turnId === turnId,
      )?.conversationId;
      await db.insert(schema.agentTurnEvents).values({
        eventId: `turn-event:reclaimed:${randomUUID()}`,
        turnId,
        conversationId: conversationId ?? "",
        eventType: "tool_execution_reclaimed",
        reasonCode: "tool_execution_lease_expired",
        payload: {
          executionCount: reclaimed.length,
          staleBefore: staleBefore.toISOString(),
        },
      });
    }
  }
  return turnIds;
}

/** Historical name retained for callers outside the dispatcher. */
export async function failStalePlannedTurns(
  db: NodePgDatabase<typeof schema>,
  staleBefore: Date,
): Promise<void> {
  await recoverStalePlannedTurns(
    db,
    new Date(staleBefore.getTime() + STALE_RUNNING_TURN_MS),
  );
}

/**
 * Requeue a tool-planned turn whose persisted execution has already finished.
 * This covers a worker crash after tool completion but before final-model
 * finalization.
 */
export async function requeueCompletedToolTurns(
  db: NodePgDatabase<typeof schema>,
  staleBefore: Date,
): Promise<string[]> {
  const rows = await db
    .update(schema.agentTurns)
    .set({ status: "queued", errorCode: "execution_resumed" })
    .where(
      and(
        eq(schema.agentTurns.status, "tool_planned"),
        lt(schema.agentTurns.startedAt, staleBefore),
        sql`EXISTS (
          SELECT 1 FROM agent.tool_executions te
          WHERE te.turn_id = ${schema.agentTurns.turnId}
            AND te.status = 'succeeded'
        )`,
      ),
    )
    .returning({ turnId: schema.agentTurns.turnId });
  return rows.map((row) => row.turnId);
}

function compareTurns(left: QueuedAgentTurn, right: QueuedAgentTurn): number {
  const createdAt = left.createdAt.getTime() - right.createdAt.getTime();
  return createdAt === 0 ? left.turnId.localeCompare(right.turnId) : createdAt;
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

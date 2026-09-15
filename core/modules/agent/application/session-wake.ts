/**
 * 会话唤醒（Session Wake）登记与消费（Phase 3）。
 *
 * wait 决策翻译成一行持久的唤醒计划：wakeAt 到点由 dispatcher 触发
 * 续轮（或按预承诺 nudge 直接代发，不开模型——省掉 qq-bridge 式
 * 沉默唤醒的空转轮）。照 turn_admission/memory_capture 家法。
 */
import { and, desc, eq, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import {
  DEFAULT_SESSION_TTL_MS,
  MAX_ROUNDS_PER_SESSION,
} from "./agent-session.js";

export type SessionWakeInput = {
  conversationId: string;
  turnId: string;
  waitMs: number;
  /** 预承诺话术：超时后由代码直发的提醒；空=超时只收尾不发消息。 */
  nudgeText?: string | undefined;
  now: Date;
};

/**
 * 把一次 wait 决策落成唤醒行。幂等键是 turnId——同一轮重复决策
 * 覆盖旧计划（onConflictDoUpdate）。
 */
export async function scheduleSessionWake(
  db: NodePgDatabase<typeof schema>,
  input: SessionWakeInput,
): Promise<void> {
  await db
    .insert(schema.sessionWakes)
    .values({
      conversationId: input.conversationId,
      turnId: input.turnId,
      kind: "wait_timeout",
      status: "scheduled",
      wakeAt: new Date(input.now.getTime() + input.waitMs),
      nudgeText: input.nudgeText ?? null,
    })
    .onConflictDoUpdate({
      target: schema.sessionWakes.turnId,
      set: {
        conversationId: input.conversationId,
        kind: "wait_timeout",
        status: "scheduled",
        wakeAt: new Date(input.now.getTime() + input.waitMs),
        nudgeText: input.nudgeText ?? null,
      },
    });
}

/**
 * wait 决策时同步维护会话行：active/waiting 状态 + 轮数累计。
 * 已 closed 的会话不复活（终态由收尾路径或策略闸门管理）。
 */
export async function ensureSessionOnWait(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    turnId: string;
    now: Date;
    ttlMs?: number | undefined;
    roundBudget?: number | undefined;
  },
): Promise<void> {
  const [existing] = await db
    .select({
      sessionId: schema.agentSessions.sessionId,
      state: schema.agentSessions.state,
      roundsUsed: schema.agentSessions.roundsUsed,
    })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.conversationId, input.conversationId))
    .orderBy(desc(schema.agentSessions.startedAt))
    .limit(1);
  if (existing) {
    if (existing.state === "closed") return;
    await db
      .update(schema.agentSessions)
      .set({
        state: "waiting",
        roundsUsed: existing.roundsUsed + 1,
        updatedAt: input.now,
      })
      .where(eq(schema.agentSessions.sessionId, existing.sessionId));
    return;
  }
  const ttlMs = input.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const roundBudget = input.roundBudget ?? MAX_ROUNDS_PER_SESSION;
  await db
    .insert(schema.agentSessions)
    .values({
      sessionId: `session:${input.turnId}`,
      conversationId: input.conversationId,
      state: "waiting",
      roundsUsed: 1,
      roundBudget,
      startedAt: new Date(input.now.getTime() - ttlMs + 60_000),
    })
    .onConflictDoNothing();
}

/** dispatcher 扫描到期唤醒行。 */
export async function claimDueSessionWakes(
  db: NodePgDatabase<typeof schema>,
  now: Date,
  limit = 100,
) {
  return db
    .select()
    .from(schema.sessionWakes)
    .where(
      and(
        eq(schema.sessionWakes.status, "scheduled"),
        lte(schema.sessionWakes.wakeAt, now),
      ),
    )
    .limit(limit);
}

/** 消费完成标记。 */
export async function markWakeDone(
  db: NodePgDatabase<typeof schema>,
  wakeId: number,
): Promise<void> {
  await db
    .update(schema.sessionWakes)
    .set({ status: "done" })
    .where(eq(schema.sessionWakes.wakeId, wakeId));
}

/**
 * 新入站作废：对方开口即打断等待——pending 唤醒不再到期触发
 * （避免唤醒轮追着已处理的新消息跑）。由 ingest 链路在入站消息
 * 落库后调用，语义对齐 cancelPendingScheduledSendsOnInbound。
 */
export async function cancelPendingSessionWakesOnInbound(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
): Promise<number> {
  const updated = await db
    .update(schema.sessionWakes)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(schema.sessionWakes.conversationId, conversationId),
        eq(schema.sessionWakes.status, "scheduled"),
      ),
    )
    .returning({ wakeId: schema.sessionWakes.wakeId });
  return updated.length;
}

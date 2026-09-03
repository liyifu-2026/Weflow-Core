/**
 * 会话唤醒（Session Wake）登记与消费（Phase 3）。
 *
 * wait 决策翻译成一行持久的唤醒计划：wakeAt 到点由 dispatcher 触发
 * 续轮（或按预承诺 nudge 直接代发，不开模型——省掉 qq-bridge 式
 * 沉默唤醒的空转轮）。照 turn_admission/memory_capture 家法。
 */
import { and, eq, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

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

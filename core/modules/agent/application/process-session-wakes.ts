/**
 * 会话唤醒消费 dispatcher（Phase 3）。
 *
 * 把到期的 session_wakes 行兑现为动作：
 * - 带 nudge_text：经 createAgentReply 直发预承诺话术（落 outbound
 *   message，sendState=pending，既有 outbound poller 负责真实发送）——
 *   超时提醒不需要模型参与，省掉沉默唤醒的空转轮；
 * - 无 nudge_text：建一个 queued Agent Turn（唤醒续轮，模型面对
 *   上下文自行判断说什么或收尾）。
 * 消费后一律置 done；动作失败不阻断标记，避免重复发送。
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { Logger } from "pino";
import {
  claimDueSessionWakes,
  markWakeDone,
} from "./session-wake.js";
import { createAgentReply } from "../../conversations/application/message-service.js";
import { isAgentPaused } from "../../handoff/application/handoff-service.js";

export type WakeProcessorDeps = {
  /** nudge 直发（默认 createAgentReply；测试可注入） */
  createAgentReply?: (
    db: NodePgDatabase<typeof schema>,
    input: {
      conversationId: string;
      turnId: string;
      traceId: string;
      segments: string[];
      variant: "direct";
    },
  ) => Promise<{ created: boolean }>;
  /** 无 nudge 时建续轮 turn（默认直接 insert agentTurns；测试可注入） */
  createTurn?: (input: {
    conversationId: string;
    wakeId: number;
  }) => Promise<boolean>;
  /** 策略闸门复检（默认 isAgentPaused + contactProfiles.agentEnabled） */
  checkGates?: (input: {
    conversationId: string;
  }) => Promise<{ blocked: boolean; reason: "handoff_active" | "agent_disabled" }>;
};

export async function processDueSessionWakes(
  db: NodePgDatabase<typeof schema>,
  deps?: WakeProcessorDeps,
  logger?: Pick<Logger, "error" | "info">,
  now = new Date(),
): Promise<number> {
  const due = await claimDueSessionWakes(db, now);
  const sendNudge =
    deps?.createAgentReply ??
    (async (mdb, input) => {
      const result = await createAgentReply(mdb, {
        ...input,
        variant: "direct",
      });
      return { created: result.created };
    });
  const createTurn =
    deps?.createTurn ??
    (async (input) => {
      await db
        .insert(schema.agentTurns)
        .values({
          turnId: `turn:wake:${input.wakeId}`,
          triggerMessageId: null as never,
          conversationId: input.conversationId,
          status: "queued",
          traceId: `session-wake:${input.wakeId}`,
        })
        .onConflictDoNothing();
      return true;
    });
  // 策略闸门（代码持有，模型不可绕过）：窗口期内 Handoff 接管或白名单
  // 摘除后，到点的唤醒必须静默作废——绝不向已转人工/已停用的客户发消息。
  const checkGates =
    deps?.checkGates ??
    (async (input) => {
      if (await isAgentPaused(db, input.conversationId)) {
        return { blocked: true, reason: "handoff_active" as const };
      }
      const [contact] = await db
        .select({ agentEnabled: schema.contactProfiles.agentEnabled })
        .from(schema.contactProfiles)
        .innerJoin(
          schema.conversations,
          eq(schema.conversations.contactId, schema.contactProfiles.contactId),
        )
        .where(eq(schema.conversations.conversationId, input.conversationId))
        .limit(1);
      if (!contact?.agentEnabled) {
        return { blocked: true, reason: "agent_disabled" as const };
      }
      return { blocked: false, reason: "handoff_active" as const };
    });

  let processed = 0;
  let actioned = 0;
  for (const wake of due) {
    try {
      const gates = await checkGates({
        conversationId: wake.conversationId,
      });
      if (gates.blocked) {
        // 静默作废：置 done，不直发、不建轮
        await markWakeDone(db, wake.wakeId);
        continue;
      }
      if (wake.nudgeText) {
        await sendNudge(db, {
          conversationId: wake.conversationId,
          turnId: wake.turnId,
          traceId: `session-wake:${String(wake.wakeId)}`,
          segments: [wake.nudgeText],
          variant: "direct",
        });
      } else {
        await createTurn({
          conversationId: wake.conversationId,
          wakeId: wake.wakeId,
        });
      }
      actioned += 1;
    } catch (error) {
      logger?.error(
        { err: error, wakeId: wake.wakeId },
        "session wake action failed",
      );
    } finally {
      await markWakeDone(db, wake.wakeId);
      processed += 1;
    }
  }
  return actioned;
}

/** 兼容既有调用面：按 wakeId 更新状态行。 */
export async function markWakeDoneById(
  db: NodePgDatabase<typeof schema>,
  wakeId: number,
): Promise<void> {
  await db
    .update(schema.sessionWakes)
    .set({ status: "done" })
    .where(eq(schema.sessionWakes.wakeId, wakeId));
}

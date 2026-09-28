/**
 * 会话唤醒消费 dispatcher（Phase 3）。
 *
 * 把到期的 session_wakes 行兑现为动作：
 * - 带 nudge_text：经 createAgentReply 直发预承诺话术（落 outbound
 *   message，sendState=pending，既有 outbound poller 负责真实发送）——
 *   超时提醒不需要模型参与，省掉沉默唤醒的空转轮；
 * - 无 nudge_text：建一个 queued Agent Turn（唤醒续轮，模型面对
 *   上下文自行判断说什么或收尾）。
 *
 * 认领即 CAS（scheduled → firing，见 session-wake.claimDueSessionWakes）：
 * 与「新入站作废」互斥；双保险是认领后再查一次「唤醒登记之后客户是否
 * 已开口」，开口则放弃 nudge（提醒绝不追着客户的新消息发）。
 * 消费后 firing → done；动作失败不阻断标记，避免重复发送。
 */
import { and, desc, eq, gt, like, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { Logger } from "pino";
import { claimDueSessionWakes, markWakeDone } from "./session-wake.js";
import {
  createAgentReply,
  latestAgentEmployeeActorId,
} from "../../conversations/application/message-service.js";
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
      variant: "nudge";
      actorId?: string | undefined;
    },
  ) => Promise<{ created: boolean }>;
  /** 无 nudge 时建续轮 turn（默认直接 insert agentTurns；测试可注入） */
  createTurn?: (input: {
    conversationId: string;
    wakeId: number;
  }) => Promise<boolean>;
  /** 策略闸门复检（默认 isAgentPaused + contactProfiles.agentEnabled） */
  checkGates?: (input: { conversationId: string }) => Promise<{
    blocked: boolean;
    reason: "handoff_active" | "agent_disabled";
  }>;
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
        conversationId: input.conversationId,
        turnId: input.turnId,
        traceId: input.traceId,
        segments: input.segments,
        variant: "nudge",
        ...(input.actorId ? { actorId: input.actorId } : {}),
      });
      return { created: result.created };
    });
  const createTurn =
    deps?.createTurn ??
    (async (input) => {
      // 连续唤醒封顶（提示词对模型的「连续唤醒 2 次后 end_session」约定，
      // 代码侧兜底）：自该会话最后一条入站消息以来已建过 >=2 个唤醒轮仍无
      // 客户动静时，不再建轮空转——静默关闭会话片段（对方开口会开新会话）。
      const [lastInbound] = await db
        .select({ occurredAt: schema.messages.occurredAt })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.conversationId, input.conversationId),
            eq(schema.messages.direction, "inbound"),
          ),
        )
        .orderBy(desc(schema.messages.occurredAt))
        .limit(1);
      const since = lastInbound?.occurredAt ?? new Date(0);
      const wakeRounds = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.agentTurns)
        .where(
          and(
            eq(schema.agentTurns.conversationId, input.conversationId),
            like(schema.agentTurns.traceId, "session-wake:%"),
            gt(schema.agentTurns.createdAt, since),
          ),
        );
      const wakeRoundCount = wakeRounds[0]?.count ?? 0;
      if (wakeRoundCount >= 2) {
        await db
          .update(schema.agentSessions)
          .set({ state: "closed", closedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(schema.agentSessions.conversationId, input.conversationId),
              eq(schema.agentSessions.state, "waiting"),
            ),
          );
        return false;
      }
      await db
        .insert(schema.agentTurns)
        .values({
          turnId: `turn:wake:${String(input.wakeId)}`,
          // 唤醒续轮没有客户触发消息（0081 起该列允许 NULL）
          triggerMessageId: null,
          conversationId: input.conversationId,
          status: "queued",
          traceId: `session-wake:${String(input.wakeId)}`,
        })
        .onConflictDoNothing();
      return true;
    });
  // 策略闸门（代码持有，模型不可绕过）：窗口期内 Handoff 接管或自动回复
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
        // 双保险：唤醒登记之后客户已开口（本条入站尚未走到作废——例如
        // 与认领同刻竞态），这条提醒就是过时的，放弃。
        const [latestInbound] = await db
          .select({ occurredAt: schema.messages.occurredAt })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.conversationId, wake.conversationId),
              eq(schema.messages.direction, "inbound"),
            ),
          )
          .orderBy(desc(schema.messages.occurredAt))
          .limit(1);
        if (
          latestInbound &&
          latestInbound.occurredAt.getTime() > wake.createdAt.getTime()
        ) {
          await markWakeDone(db, wake.wakeId);
          continue;
        }
        // 延续该会话最近一次 AI 回复的员工身份（无历史则 null=通用 Agent）
        const actorId = await latestAgentEmployeeActorId(
          db,
          wake.conversationId,
        );
        await sendNudge(db, {
          conversationId: wake.conversationId,
          turnId: wake.turnId,
          traceId: `session-wake:${String(wake.wakeId)}`,
          segments: [wake.nudgeText],
          variant: "nudge",
          actorId,
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
    }
  }
  return actioned;
}

/** 兼容既有调用面：按 wakeId 更新状态行。 */
export async function markWakeDoneById(
  db: NodePgDatabase<typeof schema>,
  wakeId: number,
): Promise<void> {
  await markWakeDone(db, wakeId);
}

/**
 * 定时发送（SCHEDULED-SEND-PLAN）：schedule_send 决策的持久化、护栏与
 * 到点执行。预承诺直发家法——内容在决策时定死，到点走 createAgentReply
 * 直发（不调用模型），真实出站由既有 outbound poller 负责。
 *
 * 生命周期（决策 #5/#6/#7）：
 *   pending → fired（到点直发）
 *           → cancelled(new_inbound)   到点前会话出现新入站，并入正常轮次
 *           → cancelled(agent_disabled / operated)
 *           → frozen(handoff)          人工接入即冻结，待审：放行/改期/丢弃
 * 护栏（可配，behavior 设置）：pending ≤2/联系人；每日直发 ≤10；
 * 落点 22:00–08:00 顺延至 08:00。
 */
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { createAgentReply } from "../../conversations/application/message-service.js";
import { isAgentPaused } from "../../handoff/application/handoff-service.js";

type Database = NodePgDatabase<typeof schema>;

export type ScheduledSendStatus =
  | "pending"
  | "fired"
  | "cancelled"
  | "frozen";

/** 一轮至多一条定时发送：幂等键从来源 turnId 派生。 */
export function scheduledSendIdForTurn(turnId: string): string {
  return `scheduled:${turnId}`;
}

/** 到点执行时用于派生出站消息 id 的合成轮标识（避免与原轮回复撞车）。 */
function fireTurnId(scheduledSendId: string): string {
  return `${scheduledSendId}:fire`;
}

/** 排定一条定时发送（幂等：同轮重复决策不产生第二行）。 */
export async function commitScheduledSend(
  db: Database,
  input: {
    conversationId: string;
    turnId: string;
    content: string;
    sendAt: Date;
  },
): Promise<{ created: boolean }> {
  const inserted = await db
    .insert(schema.scheduledSends)
    .values({
      scheduledSendId: scheduledSendIdForTurn(input.turnId),
      conversationId: input.conversationId,
      turnId: input.turnId,
      content: input.content,
      status: "pending",
      sendAt: input.sendAt,
    })
    .onConflictDoNothing()
    .returning({ id: schema.scheduledSends.scheduledSendId });
  return { created: inserted.length > 0 };
}

export async function countPendingScheduledSends(
  db: Database,
  conversationId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.scheduledSends)
    .where(
      and(
        eq(schema.scheduledSends.conversationId, conversationId),
        eq(schema.scheduledSends.status, "pending"),
      ),
    );
  return rows[0]?.count ?? 0;
}

export async function countFiredScheduledSendsSince(
  db: Database,
  conversationId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.scheduledSends)
    .where(
      and(
        eq(schema.scheduledSends.conversationId, conversationId),
        eq(schema.scheduledSends.status, "fired"),
        gte(schema.scheduledSends.updatedAt, since),
      ),
    );
  return rows[0]?.count ?? 0;
}

/** 当日（自 since 起）排定总数（含全部状态）——每日上限护栏的口径。 */
export async function countScheduledSendsCreatedSince(
  db: Database,
  conversationId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.scheduledSends)
    .where(
      and(
        eq(schema.scheduledSends.conversationId, conversationId),
        gte(schema.scheduledSends.createdAt, since),
      ),
    );
  return rows[0]?.count ?? 0;
}

/**
 * 新入站作废（决策 #5）：由 ingest 链路在入站消息落库后调用。
 * 作废而非删除——正常轮次的上下文构建会展示它，模型自行决定补发/改期。
 */
export async function cancelPendingScheduledSendsOnInbound(
  db: Database,
  conversationId: string,
): Promise<number> {
  return cancelPendingScheduledSendsForConversation(db, conversationId, "new_inbound");
}

/** 按原因作废会话全部 pending 定时发送（新入站 / 联系人开关关闭）。 */
export async function cancelPendingScheduledSendsForConversation(
  db: Database,
  conversationId: string,
  reason: string = "new_inbound",
): Promise<number> {
  const updated = await db
    .update(schema.scheduledSends)
    .set({ status: "cancelled", cancelReason: reason, updatedAt: new Date() })
    .where(
      and(
        eq(schema.scheduledSends.conversationId, conversationId),
        eq(schema.scheduledSends.status, "pending"),
      ),
    )
    .returning({ id: schema.scheduledSends.scheduledSendId });
  return updated.length;
}

/** 人工接入即冻结（决策 #6）：handoff 建立时由 handoff 提交路径调用。 */
export async function freezePendingScheduledSendsForHandoff(
  db: Database,
  conversationId: string,
): Promise<number> {
  const updated = await db
    .update(schema.scheduledSends)
    .set({ status: "frozen", cancelReason: "handoff_active", updatedAt: new Date() })
    .where(
      and(
        eq(schema.scheduledSends.conversationId, conversationId),
        eq(schema.scheduledSends.status, "pending"),
      ),
    )
    .returning({ id: schema.scheduledSends.scheduledSendId });
  return updated.length;
}

/**
 * 静音时段顺延（决策 #7）：sendAt 落在 [quietStart, quietEnd) 时推到
 * 当日/次日 quietEnd。跨午夜语义：start > end 表示窗口跨零点。
 * 返回调整后的时间；不在静音窗口原样返回。
 */
export function shiftOutOfQuietHours(
  sendAt: Date,
  quietStartHour: number,
  quietEndHour: number,
): Date {
  if (quietStartHour === quietEndHour) return sendAt;
  const hour = sendAt.getHours();
  const inWindow =
    quietStartHour < quietEndHour
      ? hour >= quietStartHour && hour < quietEndHour
      : hour >= quietStartHour || hour < quietEndHour;
  if (!inWindow) return sendAt;
  const shifted = new Date(sendAt);
  if (quietStartHour < quietEndHour || hour < quietEndHour) {
    // 窗口内且未过 End：推到今天 quietEnd（跨零点窗口的凌晨部分推当日 End）
    shifted.setHours(quietEndHour, 0, 0, 0);
  } else {
    // 窗口内且已过零点（start > end 的晚间部分）：推到次日 quietEnd
    shifted.setDate(shifted.getDate() + 1);
    shifted.setHours(quietEndHour, 0, 0, 0);
  }
  return shifted;
}

export type ProcessDueScheduledSendsDeps = {
  /** 到点直发（默认 createAgentReply；测试可注入） */
  fire?: (
    db: Database,
    input: {
      conversationId: string;
      scheduledSendId: string;
      content: string;
    },
  ) => Promise<{ messageId: string | null }>;
  /** 策略闸门（默认 isAgentPaused + contactProfiles.agentEnabled） */
  checkGates?: (input: {
    conversationId: string;
  }) => Promise<{
    blocked: boolean;
    reason: "handoff_active" | "agent_disabled";
  }>;
  quietStartHour?: number;
  quietEndHour?: number;
};

/**
 * 到点执行 dispatcher（由 api 进程的通用 dispatcher 循环驱动）。
 * 预承诺直发：handoff → frozen 待审；白名单摘除 → cancelled；
 * 其余按定死内容直发，不调用模型。失败不阻断状态收尾，避免重复发送。
 */
export async function processDueScheduledSends(
  db: Database,
  deps?: ProcessDueScheduledSendsDeps,
  logger?: { error: (obj: unknown, msg: string) => void; info?: (obj: unknown, msg: string) => void },
  now = new Date(),
): Promise<number> {
  const due = await db
    .select()
    .from(schema.scheduledSends)
    .where(
      and(
        eq(schema.scheduledSends.status, "pending"),
        lte(schema.scheduledSends.sendAt, now),
      ),
    )
    .limit(50);

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

  const fire =
    deps?.fire ??
    (async (fdb, input) => {
      const result = await createAgentReply(fdb, {
        conversationId: input.conversationId,
        turnId: fireTurnId(input.scheduledSendId),
        traceId: `scheduled-send:${input.scheduledSendId}`,
        segments: [input.content],
        variant: "direct" as const,
      });
      return {
        messageId: result.messages.at(-1)?.messageId ?? null,
      };
    });

  let actioned = 0;
  for (const row of due) {
    try {
      const gates = await checkGates({ conversationId: row.conversationId });
      if (gates.blocked) {
        if (gates.reason === "handoff_active") {
          // 决策 #6：人工接入即冻结进待审，不放、不弃——由人工处置
          await db
            .update(schema.scheduledSends)
            .set({ status: "frozen", cancelReason: "handoff_active", updatedAt: new Date() })
            .where(eq(schema.scheduledSends.scheduledSendId, row.scheduledSendId));
        } else {
          await db
            .update(schema.scheduledSends)
            .set({ status: "cancelled", cancelReason: "agent_disabled", updatedAt: new Date() })
            .where(eq(schema.scheduledSends.scheduledSendId, row.scheduledSendId));
        }
        actioned += 1;
        continue;
      }
      const quietStart = deps?.quietStartHour ?? 22;
      const quietEnd = deps?.quietEndHour ?? 8;
      const shifted = shiftOutOfQuietHours(row.sendAt, quietStart, quietEnd);
      if (shifted.getTime() !== row.sendAt.getTime()) {
        await db
          .update(schema.scheduledSends)
          .set({ sendAt: shifted, updatedAt: new Date() })
          .where(eq(schema.scheduledSends.scheduledSendId, row.scheduledSendId));
        logger?.info?.(
          { scheduledSendId: row.scheduledSendId, sendAt: shifted.toISOString() },
          "scheduled send postponed out of quiet hours",
        );
        actioned += 1;
        continue;
      }
      const result = await fire(db, {
        conversationId: row.conversationId,
        scheduledSendId: row.scheduledSendId,
        content: row.content,
      });
      await db
        .update(schema.scheduledSends)
        .set({
          status: "fired",
          firedMessageId: result.messageId,
          updatedAt: new Date(),
        })
        .where(eq(schema.scheduledSends.scheduledSendId, row.scheduledSendId));
      actioned += 1;
    } catch (error) {
      logger?.error(
        { err: error, scheduledSendId: row.scheduledSendId },
        "scheduled send action failed",
      );
    }
  }
  return actioned;
}

/** 操作动作（B3 Web）：撤销 / 改期 / 立即发；frozen 的放行 = 立即发或改期。 */
export type ScheduledSendOperation = "cancel" | "reschedule" | "fire_now";

export async function operateScheduledSend(
  db: Database,
  input: {
    scheduledSendId: string;
    operation: ScheduledSendOperation;
    newSendAt?: Date | undefined;
    operatorUserId?: string | null;
  },
): Promise<
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "invalid_state" }
  | { status: "handoff_active" }
> {
  const rows = await db
    .select()
    .from(schema.scheduledSends)
    .where(
      eq(schema.scheduledSends.scheduledSendId, input.scheduledSendId),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return { status: "not_found" };
  if (!["pending", "frozen"].includes(row.status)) {
    return { status: "invalid_state" };
  }

  if (input.operation === "cancel") {
    await db
      .update(schema.scheduledSends)
      .set({
        status: "cancelled",
        cancelReason: "operated",
        operatedByUserId: input.operatorUserId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.scheduledSends.scheduledSendId, row.scheduledSendId));
    return { status: "ok" };
  }

  if (input.operation === "reschedule") {
    if (!input.newSendAt) return { status: "invalid_state" };
    const shifted = shiftOutOfQuietHours(
      input.newSendAt,
      DEFAULT_QUIET_START,
      DEFAULT_QUIET_END,
    );
    await db
      .update(schema.scheduledSends)
      .set({
        status: "pending",
        sendAt: shifted,
        cancelReason: null,
        operatedByUserId: input.operatorUserId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.scheduledSends.scheduledSendId, row.scheduledSendId));
    return { status: "ok" };
  }

  // fire_now / 放行：handoff 期间拒绝（人工在场即人工负责，定时代发有抢话风险）
  if (await isAgentPaused(db, row.conversationId)) {
    return { status: "handoff_active" };
  }
  const result = await createAgentReply(db, {
    conversationId: row.conversationId,
    turnId: fireTurnId(row.scheduledSendId),
    traceId: `scheduled-send:${row.scheduledSendId}`,
    segments: [row.content],
    variant: "direct" as const,
  });
  await db
    .update(schema.scheduledSends)
    .set({
      status: "fired",
      firedMessageId: result.messages.at(-1)?.messageId ?? null,
      operatedByUserId: input.operatorUserId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schema.scheduledSends.scheduledSendId, row.scheduledSendId));
  return { status: "ok" };
}

const DEFAULT_QUIET_START = 22;
const DEFAULT_QUIET_END = 8;

/** 会话维度的待发/最近作废列表（上下文构建与 B3 详情接口共用）。 */
export async function listScheduledSendsForConversation(
  db: Database,
  conversationId: string,
  limit = 5,
) {
  return db
    .select()
    .from(schema.scheduledSends)
    .where(
      and(
        eq(schema.scheduledSends.conversationId, conversationId),
        inArray(schema.scheduledSends.status, ["pending", "frozen", "cancelled"]),
      ),
    )
    .orderBy(desc(schema.scheduledSends.updatedAt))
    .limit(limit);
}

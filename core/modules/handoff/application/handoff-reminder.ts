/**
 * 转人工兜底提醒（HANDOFF-REMINDER-PLAN）。
 *
 * 告别话术治本后，转人工默认静默（模型告别语只存在于模型显式选择的
 * 路径）。失败路径（模型不可用、工具链超限、客服手动接管）没有告别语，
 * 若长时间无人认领，客户会面对无解释的沉默。本模块在 handoff pending
 * 超过配置时长仍无人认领时，代发一条可配置的轻提示。
 *
 * Core 保持业务中立：提醒文案与延迟全部来自 Solution 扩展设置
 * （behavior 键，经 behavior-settings 提取）；文案为空 = 功能关闭。
 * 幂等：确定性 messageId handoff-reminder:{cycleId}，每个周期最多一条，
 * 重复执行 onConflictDoNothing 静默跳过，无需额外状态列。
 */
import { and, eq, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

export type HandoffReminderInput = {
  /** 提醒文案；空串 = 关闭（不做任何查询与发送）。 */
  reminderText: string;
  /** pending 无人认领多久后提醒（毫秒）。 */
  delayMs: number;
  now?: Date;
};

/**
 * 扫描超时未认领的 pending handoff 并代发提醒。
 * @returns 本次实际新发送的提醒条数（幂等跳过的不计）。
 */
export async function processHandoffReminders(
  db: NodePgDatabase<typeof schema>,
  input: HandoffReminderInput,
): Promise<number> {
  const text = input.reminderText.trim();
  if (text === "" || !Number.isFinite(input.delayMs) || input.delayMs <= 0) {
    return 0;
  }
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - input.delayMs);
  const stale = await db
    .select({
      conversationId: schema.handoffStates.conversationId,
      cycleId: schema.handoffStates.cycleId,
    })
    .from(schema.handoffStates)
    .where(
      and(
        eq(schema.handoffStates.status, "pending"),
        eq(schema.handoffStates.agentPaused, true),
        lte(schema.handoffStates.createdAt, cutoff),
      ),
    );
  let sent = 0;
  for (const state of stale) {
    const inserted = await db
      .insert(schema.messages)
      .values({
        messageId: `handoff-reminder:${state.cycleId}`,
        conversationId: state.conversationId,
        channelEventId: null,
        channelMessageId: null,
        direction: "outbound",
        actorType: "system",
        actorId: "system",
        contentType: "text",
        channelType: 1,
        text,
        isSelf: true,
        processingState: "not_applicable",
        sendState: "pending",
        idempotencyKey: `handoff-reminder:${state.cycleId}`,
        occurredAt: now,
        traceId: `handoff-reminder:${state.cycleId}`,
      })
      .onConflictDoNothing()
      .returning({ messageId: schema.messages.messageId });
    sent += inserted.length;
  }
  return sent;
}

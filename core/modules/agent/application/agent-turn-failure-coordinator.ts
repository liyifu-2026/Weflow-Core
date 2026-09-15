/** Queue failure reconciliation for an Agent Turn. */
import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { commitAgentTurnFailure } from "./agent-turn-outcome-command.js";
import { buildHandoffBriefing } from "../../handoff/application/handoff-briefing.js";

/**
 * 队列失败对账 + 失败转人工。
 * 交接必须写清楚：附上最后一次真实错误与客户最后一句话——
 * 只有"自动回复服务暂时不可用"一句的交接，人工接手时无从下手
 * （2026-09-07 可可猫群实测）。
 */
export async function reconcileAgentTurnQueueFailure(
  db: NodePgDatabase<typeof schema>,
  turnId: string,
  errorCode: string,
): Promise<void> {
  const rows = await db
    .select({ conversationId: schema.agentTurns.conversationId })
    .from(schema.agentTurns)
    .where(eq(schema.agentTurns.turnId, turnId))
    .limit(1);
  const conversationId = rows[0]?.conversationId;
  if (!conversationId) return;

  // 真实失败原因：本回合最后一次 turn_error 事件的消息
  const errorRows = await db
    .select({ payload: schema.agentTurnEvents.payload })
    .from(schema.agentTurnEvents)
    .where(
      and(
        eq(schema.agentTurnEvents.turnId, turnId),
        eq(schema.agentTurnEvents.eventType, "turn_error"),
      ),
    )
    .orderBy(desc(schema.agentTurnEvents.createdAt))
    .limit(1);
  const lastErrorPayload = errorRows[0]?.payload as
    { message?: string } | undefined;
  const lastError = lastErrorPayload?.message?.slice(0, 200);

  // 客户最后一句话：交接的人最需要知道"对方刚才说了什么"
  const inboundRows = await db
    .select({ text: schema.messages.text })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.direction, "inbound"),
      ),
    )
    .orderBy(desc(schema.messages.occurredAt))
    .limit(1);
  const lastCustomerMessage = inboundRows[0]?.text?.slice(0, 200);

  const detail = [
    lastError ? `最后错误：${lastError}` : undefined,
    lastCustomerMessage
      ? `客户最后消息：「${lastCustomerMessage}」`
      : undefined,
  ]
    .filter(Boolean)
    .join("；");

  const briefing = buildHandoffBriefing({
    sourceConversationRevision: 0,
    handoffReason: `模型连续调用失败（${errorCode}）${detail ? `：${detail}` : ""}`,
    modelBriefing: {
      problemSummary: `AI 回复服务连续失败（${errorCode}），无法生成回复，已转人工继续。${detail ? ` ${detail}。` : ""}`,
      unresolvedItems: lastCustomerMessage
        ? [`回应客户最后消息：「${lastCustomerMessage}」`]
        : [],
      suggestedFirstReply: "",
    },
  });

  await commitAgentTurnFailure(db, {
    conversationId,
    turnId,
    errorCode,
    handoffReason: `model_unavailable: ${errorCode}`,
    briefing,
    // 终态失败也落事件：排错从 turn_events 一处可查（不依赖 stdout 文本日志）
    events: [
      {
        eventType: "turn_failed",
        reasonCode: errorCode,
        payload: { handoffReason: `model_unavailable: ${errorCode}` },
      },
    ],
  });
}

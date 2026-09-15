/**
 * 轮次化上下文（私聊批）：把 20 条消息窗口之外的更早回合压成摘要行。
 *
 * 回合 = agent.turns 一行（触发消息 + 该 turnId 名下全部 agent 消息），
 * 从数据里精确重建（reply_batch_id 内嵌 turnId），不需要启发式。
 * 密度自适应：聊得密覆盖少而近，聊得稀覆盖多而远；且不在回合中间腰斩。
 * 摘要只取触发消息与机器人最终回复，中间过程（工具/续步）略去——
 * 细节以原文窗口与会话事实卡为准。
 */
import { and, desc, eq, gt, like, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { SendState } from "../../conversations/application/send-states.js";
import type { RoundSummaryLabels } from "./behavior-settings.js";
import { DEFAULT_ROUND_SUMMARY_LABELS } from "./behavior-settings.js";

/** 回合摘要回看的最大轮数与时间窗。 */
export const OLDER_ROUND_LIMIT = 4;
export const OLDER_ROUND_WINDOW_HOURS = 72;

/** 算作"该回合有回复"的状态：在途（pending/submitting）与已送达都算，
 *  failed/unknown/held/cancelled 不算（曾漏 submitting——提交中的回复
 *  被摘要成「未回复」）。类型标注使其与词汇表编译期对齐。 */
const ROUND_REPLY_SEND_STATES: readonly SendState[] = [
  "confirmed",
  "pending",
  "observed",
  "submitting",
];

/** 单条摘要的截断长度。 */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 收集 20 条原文窗口之前的更早回合摘要（由旧到新）。
 * @param beforeOccurrence 原文窗口中最早一条消息的时间（此前才算"更早"）
 */
export async function buildOlderRoundSummaries(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    beforeOccurrence: Date;
    now?: Date;
    limit?: number;
    /**
     * 摘要行角色标签（ADR-0011）：引擎缺省中立 customer/assistant；
     * 业务词（客户/客服）由部署种子经 behavior.roundSummaryLabels 下发。
     */
    labels?: RoundSummaryLabels;
  },
): Promise<string[]> {
  const now = input.now ?? new Date();
  const windowStart = new Date(
    now.getTime() - OLDER_ROUND_WINDOW_HOURS * 60 * 60_000,
  );
  const turns = await db
    .select({
      turnId: schema.agentTurns.turnId,
      triggerMessageId: schema.agentTurns.triggerMessageId,
      errorCode: schema.agentTurns.errorCode,
      status: schema.agentTurns.status,
      createdAt: schema.agentTurns.createdAt,
    })
    .from(schema.agentTurns)
    .where(
      and(
        eq(schema.agentTurns.conversationId, input.conversationId),
        gt(schema.agentTurns.createdAt, windowStart),
      ),
    )
    .orderBy(desc(schema.agentTurns.createdAt))
    .limit((input.limit ?? OLDER_ROUND_LIMIT) * 3);

  // 只保留：早于原文窗口的、非唤醒（无触发）的、非吸收占位的回合
  const rounds = turns
    .filter(
      (turn) =>
        turn.triggerMessageId !== null &&
        turn.createdAt < input.beforeOccurrence &&
        !(turn.errorCode ?? "").startsWith("absorbed_into"),
    )
    .slice(0, input.limit ?? OLDER_ROUND_LIMIT);
  if (rounds.length === 0) return [];

  const lines: string[] = [];
  // 由旧到新输出
  for (const turn of [...rounds].reverse()) {
    const [trigger] = await db
      .select({ text: schema.messages.text, occurredAt: schema.messages.occurredAt })
      .from(schema.messages)
      .where(eq(schema.messages.messageId, turn.triggerMessageId as string))
      .limit(1);
    const [reply] = await db
      .select({ text: schema.messages.text, createdAt: schema.messages.createdAt })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, input.conversationId),
          like(schema.messages.replyBatchId, `agent-reply:${turn.turnId}%`),
          or(
            ...ROUND_REPLY_SEND_STATES.map((state) =>
              eq(schema.messages.sendState, state),
            ),
          ),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    const when = (trigger?.occurredAt ?? turn.createdAt)
      .toISOString()
      .slice(5, 16)
      .replace("T", " ");
    const labels = input.labels ?? DEFAULT_ROUND_SUMMARY_LABELS;
    const customer = clip(trigger?.text ?? "（媒体消息）", 60);
    const agent = reply?.text ? clip(reply.text, 60) : "（未回复）";
    lines.push(`${when} ${labels.customer}：${customer}｜${labels.agent}：${agent}`);
  }
  return lines;
}

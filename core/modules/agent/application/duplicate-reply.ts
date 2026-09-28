/**
 * 重复回复守卫
 *
 * 在生成回复落库前，将新回复与上一条已送达的 Agent 回复做内容比对，
 * 逐字相同时由调用方拦截，防止模型复读自己的上一条回复。
 * 比较按批次指纹（分段排序后拼接）进行，对段序不敏感：换序复读与
 * 逐字复读是同一失败形态（2026-09-23 X230 实测）。
 */
import { and, asc, desc, eq, isNull, notInArray, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { SEND_STATE } from "../../conversations/application/send-states.js";
import {
  normalizeReplyText,
  replyFingerprint,
} from "./reply-text.js";

type DatabaseTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

export { normalizeReplyText, replyFingerprint };

/**
 * 「确定没送达」的终态：被扣留（发送期插话闸门 / kill switch）、被取消、
 * 发送失败，以及 **unknown**（对账丢失——send-states 词表明确规定 unknown
 * 终态「同 key 重试无效，须补发」）。这些行不得充当「上一条已回复」——
 * 否则新回合对未送达分段的原样补发会被守卫判成复读而永久不发
 * （ADR-0012 把补发决定交给模型，靠的就是这个守卫别误判）。
 * NULL 为 send-state 机制前的历史行，视为已发出。
 */
const UNDELIVERED_TERMINAL_SEND_STATES = [
  SEND_STATE.held,
  SEND_STATE.cancelled,
  SEND_STATE.failed,
  SEND_STATE.unknown,
] as const;

/** 参与「上一条已回复」比较的行过滤：已送达或历史行；排除确定未送达的终态。 */
function comparableToLastReply() {
  return or(
    isNull(schema.messages.sendState),
    notInArray(schema.messages.sendState, [
      ...UNDELIVERED_TERMINAL_SEND_STATES,
    ]),
  );
}

/**
 * 判断新回复是否与上一条已送达的 Agent 回复内容重复。
 * 上一条回复按整批比较（replyBatchId 内按 replySequence 取分段集），
 * 顺序无关：换序复读同样判重。
 */
export async function isDuplicateOfLastReply(
  db: NodePgDatabase<typeof schema> | DatabaseTransaction,
  conversationId: string,
  replyText: string,
): Promise<boolean> {
  const previous = await lastAgentReplySegments(db, conversationId);
  if (previous === null) return false;
  return (
    replyFingerprint(replyText) === replyFingerprint(previous.join("\n\n"))
  );
}

/**
 * 告别语复读守卫：模型显式转人工时，把上一条回复（或其换序）当告别语
 * 逐字复述是高频行为——客户侧就是同一句话连收两遍，且告别语气泡的
 * 头像按 system-agent 出图，看起来像「另一个 Agent 在说话」。
 * 逐段剔除与上一条已送达批次重复的分段，返回剩余分段；
 * 全部重复时返回空数组，调用方静默转接。
 */
export async function dropSegmentsDuplicateOfLastReply(
  db: NodePgDatabase<typeof schema> | DatabaseTransaction,
  conversationId: string,
  segments: string[],
): Promise<string[]> {
  const previous = await lastAgentReplySegments(db, conversationId);
  if (previous === null || previous.length === 0) return segments;
  const delivered = new Set(previous.map(normalizeReplyText));
  return segments.filter(
    (segment) => !delivered.has(normalizeReplyText(segment)),
  );
}

/** 查询会话内最近一条 Agent 回复批次的分段（replySequence 序），无历史回复时返回 null */
async function lastAgentReplySegments(
  db: NodePgDatabase<typeof schema> | DatabaseTransaction,
  conversationId: string,
): Promise<string[] | null> {
  const latest = await db
    .select({
      replyBatchId: schema.messages.replyBatchId,
      replySequence: schema.messages.replySequence,
      text: schema.messages.text,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.direction, "outbound"),
        eq(schema.messages.actorType, "agent"),
        comparableToLastReply(),
      ),
    )
    .orderBy(desc(schema.messages.occurredAt), desc(schema.messages.messageId))
    .limit(1);
  const last = latest[0];
  if (!last) return null;
  if (!last.replyBatchId || last.replySequence === null) {
    return [last.text];
  }
  const batch = await db
    .select({
      replySequence: schema.messages.replySequence,
      text: schema.messages.text,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.replyBatchId, last.replyBatchId),
        comparableToLastReply(),
      ),
    )
    .orderBy(asc(schema.messages.replySequence));
  return batch.map((row) => row.text);
}

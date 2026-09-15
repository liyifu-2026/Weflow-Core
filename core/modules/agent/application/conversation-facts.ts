/**
 * 会话事实卡（私聊批）：每个会话一份持久工作状态。
 *
 * 解决的问题：20 条消息窗口装不下长周期服务史——客户隔三天回来
 * "上次的问题还在"时，三天前的诊断锚点/承诺/待确认事项全部出窗。
 * 事实卡由模型随决策的 facts_card 字段全量更新（咨询性上下文，非
 * 事务事实；崩溃丢失可接受），下一回合开头注入上下文头部。
 *
 * 卡片形状（软契约，经 sanitize 收敛）：
 * { problem?, confirmed_facts?[], attempted?[], promises?[], open_questions?[] }
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

/** 数组与字符串的防御性上限。 */
const LIMITS = {
  problem: 500,
  item: 200,
  array: 20,
} as const;

const ARRAY_KEYS = [
  "confirmed_facts",
  "attempted",
  "promises",
  "open_questions",
] as const;

export type ConversationFactCard = {
  problem?: string;
  confirmed_facts?: string[];
  attempted?: string[];
  promises?: string[];
  open_questions?: string[];
};

/**
 * 把模型输出的任意 JSON 收敛为合法卡片：未知键丢弃、超长截断、
 * 超量截断、非字符串元素剔除。任何输入都不会抛错（咨询性数据，
 * 宁可残缺不可阻断回合）。
 */
export function sanitizeFactCard(raw: unknown): ConversationFactCard {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const card: ConversationFactCard = {};
  if (typeof source.problem === "string" && source.problem.trim()) {
    card.problem = source.problem.trim().slice(0, LIMITS.problem);
  }
  for (const key of ARRAY_KEYS) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().slice(0, LIMITS.item))
      .filter((item) => item !== "")
      .slice(0, LIMITS.array);
    if (items.length > 0) card[key] = items;
  }
  return card;
}

export function isEmptyFactCard(card: ConversationFactCard): boolean {
  return Object.keys(card).length === 0;
}

/** 读取会话当前事实卡；无行返回 null。 */
export async function readConversationFacts(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
): Promise<ConversationFactCard | null> {
  const rows = await db
    .select({ card: schema.conversationFacts.card })
    .from(schema.conversationFacts)
    .where(eq(schema.conversationFacts.conversationId, conversationId))
    .limit(1);
  const card = rows[0]?.card;
  if (!card || typeof card !== "object") return null;
  const sanitized = sanitizeFactCard(card);
  return isEmptyFactCard(sanitized) ? null : sanitized;
}

/** 全量替换语义写回；咨询性数据，失败由调用方吞掉。 */
export async function upsertConversationFacts(
  db: NodePgDatabase<typeof schema>,
  input: { conversationId: string; card: ConversationFactCard },
): Promise<void> {
  await db
    .insert(schema.conversationFacts)
    .values({
      conversationId: input.conversationId,
      card: input.card,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.conversationFacts.conversationId,
      set: { card: input.card, updatedAt: new Date() },
    });
}

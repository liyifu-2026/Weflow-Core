/**
 * 回复策略评估模块
 *
 * 在 Agent 轮次开始前评估是否应该回复：
 * - 检查联系人的 Agent 功能是否启用
 * - 检查会话是否处于 Handoff（转人工）状态
 *
 * 注意：此模块只做决策，不写入任何状态。
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { isConversationAgentEnabled } from "../../contacts/application/contact-profile-service.js";
import { isAgentPaused } from "../../handoff/application/handoff-service.js";

/** 回复策略决策结果 */
export type ReplyPolicyDecision =
  | { action: "reply"; reason: "agent_enabled" }
  | { action: "ignore"; reason: "agent_disabled" | "handoff_active" };

/**
 * 评估回复策略
 * @returns reply: 允许回复，ignore: 忽略（附带原因）
 */
export async function evaluateReplyPolicy(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
): Promise<ReplyPolicyDecision> {
  if (!(await isConversationAgentEnabled(db, conversationId))) {
    return { action: "ignore", reason: "agent_disabled" };
  }
  if (await isAgentPaused(db, conversationId)) {
    return { action: "ignore", reason: "handoff_active" };
  }
  return { action: "reply", reason: "agent_enabled" };
}

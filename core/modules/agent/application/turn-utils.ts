/**
 * Agent Turn 纯工具函数：状态分类、错误分类、会话类型、新旧轮次判定。
 * 全部无副作用、无 DB 之外的依赖，独立单测。
 */

import { and, eq, gt, ne, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { AgentTurnExecutionStatus } from "./agent-turn-executor.js";

type Database = NodePgDatabase<typeof schema>;

/** 终态判定：这些状态下的轮次不再执行 */
export function isTerminal(status: string): boolean {
  return [
    "completed",
    "failed",
    "superseded",
    "suppressed_policy",
    "suppressed_handoff",
  ].includes(status);
}

/** 根据 conversationId 检测会话类型：以 @chatroom 结尾为群聊 */
export function detectChatType(conversationId: string): "private" | "group" {
  return conversationId.endsWith("@chatroom") ? "group" : "private";
}

/** 未知状态统一规范为 unknown（向前兼容 host/worker 状态扩展） */
export function normalizeStatus(status: string): AgentTurnExecutionStatus {
  if (
    status === "completed" ||
    status === "failed" ||
    status === "superseded" ||
    status === "suppressed_policy" ||
    status === "suppressed_handoff" ||
    status === "queued" ||
    status === "tool_planned" ||
    status === "running"
  ) {
    return status;
  }
  return "unknown";
}

/** 将异常分类为错误码，用于重试策略判断 */
export function classifyError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "model_timeout";
  }
  return "model_request_failed";
}

/**
 * 检查是否存在比当前轮次更新的 Agent 轮次
 * 基于触发消息的发送时间和消息 ID 排序判断
 */
export async function hasNewerAgentTurn(
  db: Database,
  turn: typeof schema.agentTurns.$inferSelect,
): Promise<boolean> {
  const [trigger] = await db
    .select({
      messageId: schema.messages.messageId,
      occurredAt: schema.messages.occurredAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.messageId, turn.triggerMessageId))
    .limit(1);
  if (!trigger) return false;
  const newer = await db
    .select({ turnId: schema.agentTurns.turnId })
    .from(schema.agentTurns)
    .innerJoin(
      schema.messages,
      eq(schema.messages.messageId, schema.agentTurns.triggerMessageId),
    )
    .where(
      and(
        eq(schema.agentTurns.conversationId, turn.conversationId),
        ne(schema.agentTurns.turnId, turn.turnId),
        or(
          gt(schema.messages.occurredAt, trigger.occurredAt),
          and(
            eq(schema.messages.occurredAt, trigger.occurredAt),
            gt(schema.messages.messageId, trigger.messageId),
          ),
        ),
      ),
    )
    .limit(1);
  return newer.length > 0;
}

/** 根据轮次 ID 查询所属会话 ID */
export async function getAgentTurnConversationId(
  db: Database,
  turnId: string,
): Promise<string> {
  const rows = await db
    .select({ conversationId: schema.agentTurns.conversationId })
    .from(schema.agentTurns)
    .where(eq(schema.agentTurns.turnId, turnId))
    .limit(1);
  if (!rows[0]) throw new Error(`agent turn ${turnId} does not exist`);
  return rows[0].conversationId;
}

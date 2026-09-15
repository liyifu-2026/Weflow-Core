/**
 * Agent Turn 纯工具函数：状态分类、错误分类、会话类型、新旧轮次判定。
 * 全部无副作用、无 DB 之外的依赖，独立单测。
 */

import { and, eq, gt, inArray, ne, or } from "drizzle-orm";
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

// 会话类型判定（原 detectChatType）已随 ADR-0010 删除：chatType 是
// conversations.chat_type 落库事实，后缀回退推导仅存于
// conversations/application/chat-type.ts（ingest 单点 + 读取兜底）。

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
 * 查找比当前轮次更新、仍在执行（queued/tool_planned/running）的轮次 ID。
 * 吸收式回合用：把这些轮标记为 absorbed（superseded + 原因码）后，
 * 当前回合以新鲜上下文重决策——插话被编织进当前 episode，而非打断重启。
 * 只统计仍在执行的轮次：已被合并/取代的终态轮次不再算数——否则合并窗口
 * 留下的幸存者可能被一个"更新的死轮次"处决，导致同会话双双 superseded、
 * 客户收不到任何回复（2026-09-06 实测）。
 */
export async function findNewerActiveTurnIds(
  db: Database,
  turn: {
    turnId: string;
    conversationId: string;
    triggerMessageId: string;
  },
): Promise<string[]> {
  const [trigger] = await db
    .select({
      messageId: schema.messages.messageId,
      occurredAt: schema.messages.occurredAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.messageId, turn.triggerMessageId))
    .limit(1);
  if (!trigger) return [];
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
        inArray(schema.agentTurns.status, [
          "queued",
          "running",
          "tool_planned",
        ]),
        or(
          gt(schema.messages.occurredAt, trigger.occurredAt),
          and(
            eq(schema.messages.occurredAt, trigger.occurredAt),
            gt(schema.messages.messageId, trigger.messageId),
          ),
        ),
      ),
    )
    .limit(10);
  return newer.map((row) => row.turnId);
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

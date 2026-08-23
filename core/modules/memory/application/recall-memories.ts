/**
 * 记忆召回
 *
 * 查询指定会话关联联系人的活跃记忆，按重要度优先、最近更新优先返回。
 * 用于在 Agent 上下文组装时提供历史记忆信息。
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

/**
 * 召回指定会话的活跃记忆
 *
 * 通过会话-联系人关联查询活跃状态的记忆条目。
 * 返回数量限制在 1-50 之间。
 */
export async function recallMemories(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
  limit = 12,
) {
  const rows = await db
    .select({
      memoryId: schema.memories.memoryId,
      kind: schema.memories.kind,
      memoryKey: schema.memories.memoryKey,
      content: schema.memories.content,
      confidence: schema.memories.confidence,
      importance: schema.memories.importance,
      lastRecalledAt: schema.memories.lastRecalledAt,
    })
    .from(schema.conversations)
    .innerJoin(
      schema.memories,
      eq(schema.memories.contactId, schema.conversations.contactId),
    )
    .where(
      and(
        eq(schema.conversations.conversationId, conversationId),
        eq(schema.memories.status, "active"),
      ),
    )
    .orderBy(
      desc(schema.memories.importance),
      desc(schema.memories.updatedAt),
    )
    .limit(Math.min(Math.max(limit, 1), 50));

  if (rows.length > 0) {
    const now = new Date();
    await db
      .update(schema.memories)
      .set({ lastRecalledAt: now })
      .where(
        and(
          eq(schema.memories.status, "active"),
          inArray(
            schema.memories.memoryId,
            rows.map((row) => row.memoryId),
          ),
        ),
      );
  }

  return rows;
}

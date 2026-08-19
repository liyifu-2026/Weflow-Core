/**
 * conversation 级 ownership 锁
 *
 * 人工接管（take-over/claim/transfer/finish）与 Agent 出站消息落库必须竞争同一把
 * Postgres advisory lock，从结构上杜绝「Human owner 存在时 Agent 仍然外发」的双发窗口。
 *
 * 用法：在事务开头调用（事务提交/回滚时自动释放）：
 *
 *   await db.transaction(async (tx) => {
 *     await lockConversationOwnership(tx, conversationId);
 *     // 取锁后再读 agentPaused / handoff status —— 读到的即为权威
 *   });
 *
 * 锁键为 `weflow:ownership:<conversationId>` 的 hashtext（32 位）。不同会话偶发碰撞
 * 只会造成无害的串行化，不影响正确性。
 */
import { sql, type SQL } from "drizzle-orm";

/** 满足 execute(SQL) 的数据库连接或事务（NodePgDatabase 与 PgTransaction 均满足） */
type LockableDb = {
  execute: (query: SQL) => Promise<unknown>;
};

export async function lockConversationOwnership(
  db: LockableDb,
  conversationId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`weflow:ownership:${conversationId}`}))`,
  );
}

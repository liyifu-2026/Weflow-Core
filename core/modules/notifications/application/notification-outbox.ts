/**
 * 通知发件箱
 *
 * 提供通知的入队功能，用于在交接（handoff）和新消息等场景下
 * 向相关用户发送通知。通过 dedupeKey 实现通知去重，
 * 避免短时间内重复发送相同类型的通知。
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

type Transaction = Parameters<
  NodePgDatabase<typeof schema>["transaction"]
>[0] extends (tx: infer T) => Promise<unknown>
  ? T
  : never;

/** 为所有活跃用户入队待处理交接通知 */
export async function enqueuePendingHandoffNotifications(
  transaction: Transaction,
  conversationId: string,
  cycleId: string,
  bucket = "created",
  queueId?: string | null,
): Promise<void> {
  const users =
    queueId && queueId !== "queue-general"
      ? await transaction
          .select({ userId: schema.users.userId })
          .from(schema.users)
          .where(
            and(
              eq(schema.users.status, "active"),
              // 队列成员 或 名片标签包含该队列 key（标签与队列同源）
              or(
                inArray(
                  schema.users.userId,
                  transaction
                    .select({ userId: schema.queueMembers.userId })
                    .from(schema.queueMembers)
                    .where(
                      and(
                        eq(schema.queueMembers.queueId, queueId),
                        eq(schema.queueMembers.isActive, true),
                      ),
                    ),
                ),
                sql`${schema.users.tags} ? (SELECT key FROM collaboration.specialist_queues WHERE queue_id = ${queueId})`,
              ),
            ),
          )
          .for("key share")
      : await transaction
          .select({ userId: schema.users.userId })
          .from(schema.users)
          .where(eq(schema.users.status, "active"))
          .for("key share");
  for (const user of users) {
    await enqueue(
      transaction,
      user.userId,
      conversationId,
      "handoff_pending",
      `${cycleId}:${bucket}`,
    );
  }
}

/** 为负责客服入队新客户消息通知（5 分钟时间桶去重） */
export async function enqueueAssigneeInboundNotification(
  transaction: Transaction,
  conversationId: string,
  userId: string,
  occurredAt: Date,
): Promise<void> {
  await enqueue(
    transaction,
    userId,
    conversationId,
    "assignee_inbound",
    String(Math.floor(occurredAt.getTime() / 300_000)),
  );
}

/** 为被指派用户入队交接转移通知 */
export async function enqueueHandoffTransferNotification(
  transaction: Transaction,
  conversationId: string,
  userId: string,
  eventId: string,
): Promise<void> {
  await enqueue(
    transaction,
    userId,
    conversationId,
    "handoff_assigned",
    eventId,
  );
}

/**
 * 通用通知入队（内部方法）
 *
 * 通过 SHA-256 哈希生成通知 ID，使用 onConflictDoNothing 实现去重。
 */
async function enqueue(
  transaction: Transaction,
  userId: string,
  conversationId: string,
  kind: "handoff_pending" | "assignee_inbound" | "handoff_assigned",
  bucket: string,
): Promise<void> {
  const dedupeKey = `${kind}:${userId}:${conversationId}:${bucket}`;
  await transaction
    .insert(schema.notificationOutbox)
    .values({
      notificationId: `notification:${createHash("sha256").update(dedupeKey).digest("hex")}`,
      userId,
      conversationId,
      kind,
      dedupeKey,
      payload: { conversationId, kind },
    })
    .onConflictDoNothing();
}

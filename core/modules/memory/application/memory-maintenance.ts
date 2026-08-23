/**
 * 记忆维护
 *
 * 完整记忆增强中的自动淘汰：当某个联系人的活跃记忆超过容量上限时，
 * 优先淘汰重要度低、更新时间旧的记忆。
 */
import { asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import * as schema from "../../../infrastructure/postgres/schema.js";

export const MAX_ACTIVE_MEMORIES_PER_CONTACT = 50;

export async function runMemoryMaintenance(
  db: NodePgDatabase<typeof schema>,
): Promise<number> {
  const rows = await db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.status, "active"))
    .orderBy(
      asc(schema.memories.contactId),
      asc(schema.memories.importance),
      asc(schema.memories.updatedAt),
    );

  const byContact = new Map<
    string,
    typeof schema.memories.$inferSelect[]
  >();
  for (const row of rows) {
    const list = byContact.get(row.contactId) ?? [];
    list.push(row);
    byContact.set(row.contactId, list);
  }

  const now = new Date();
  let invalidated = 0;
  for (const list of byContact.values()) {
    if (list.length <= MAX_ACTIVE_MEMORIES_PER_CONTACT) continue;
    const extra = list.slice(0, list.length - MAX_ACTIVE_MEMORIES_PER_CONTACT);
    for (const memory of extra) {
      await db
        .update(schema.memories)
        .set({
          status: "invalidated",
          invalidatedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.memories.memoryId, memory.memoryId));
      invalidated += 1;
    }
  }
  return invalidated;
}

export function startMemoryMaintenance(
  db: NodePgDatabase<typeof schema>,
  logger: Pick<Logger, "error" | "info">,
  intervalMs = 60_000,
): () => void {
  const abortController = new AbortController();
  const run = async (): Promise<void> => {
    while (!abortController.signal.aborted) {
      try {
        const count = await runMemoryMaintenance(db);
        if (count > 0) {
          logger.info({ count }, "Memory maintenance invalidated memories");
        }
      } catch (error) {
        logger.error({ err: error }, "Memory maintenance failed");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        abortController.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  };
  void run();
  return () => {
    abortController.abort();
  };
}

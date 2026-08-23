/**
 * 记忆管理服务
 *
 * 提供记忆的查询、手动创建、状态变更（激活/失效）等操作。
 * 所有写操作均支持幂等性（通过 clientRequestId 去重），
 * 并记录记忆事件和审计日志。
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { memoryIdFor } from "./memory-extraction.js";

type MemoryKind = "fact" | "preference" | "relationship";

/** 查询会话关联的所有记忆（按状态筛选） */
export async function listConversationMemories(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
  statuses: string[],
) {
  return db
    .select({ memory: schema.memories })
    .from(schema.conversations)
    .innerJoin(
      schema.memories,
      eq(schema.memories.contactId, schema.conversations.contactId),
    )
    .where(
      and(
        eq(schema.conversations.conversationId, conversationId),
        inArray(schema.memories.status, statuses),
      ),
    )
    .orderBy(desc(schema.memories.updatedAt))
    .limit(200);
}

/**
 * 手动创建记忆
 *
 * 客服人员手动添加的记忆，置信度设为 100。
 * 同类型的已有活跃记忆会被标记为 superseded。
 * 支持幂等性：相同 clientRequestId 重复调用返回已有结果。
 */
export async function createManualMemory(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    actorUserId: string;
    clientRequestId: string;
    sourceIp: string;
    kind: MemoryKind;
    memoryKey: string;
    content: string;
    importance?: number;
  },
): Promise<
  | {
      status: "ok";
      replayed: boolean;
      memory: typeof schema.memories.$inferSelect;
    }
  | { status: "conversation_not_found" }
  | { status: "idempotency_conflict" }
> {
  return db.transaction(async (transaction) => {
    const prior = await transaction
      .select({
        event: schema.memoryEvents,
        memory: schema.memories,
      })
      .from(schema.memoryEvents)
      .innerJoin(
        schema.memories,
        eq(schema.memories.memoryId, schema.memoryEvents.memoryId),
      )
      .where(eq(schema.memoryEvents.clientRequestId, input.clientRequestId))
      .limit(1);
    if (prior[0]) {
      const matches =
        prior[0].event.eventType === "created" &&
        prior[0].memory.kind === input.kind &&
        prior[0].memory.memoryKey === input.memoryKey &&
        prior[0].memory.content === input.content &&
        prior[0].event.metadata.conversationId === input.conversationId;
      return matches
        ? { status: "ok", replayed: true, memory: prior[0].memory }
        : { status: "idempotency_conflict" };
    }

    const conversations = await transaction
      .select({ contactId: schema.conversations.contactId })
      .from(schema.conversations)
      .where(eq(schema.conversations.conversationId, input.conversationId))
      .limit(1);
    const conversation = conversations[0];
    if (!conversation) return { status: "conversation_not_found" };

    const memoryId = memoryIdFor(
      conversation.contactId,
      input.kind,
      input.memoryKey,
      input.content,
    );
    const now = new Date();
    await supersedeActive(
      transaction,
      conversation.contactId,
      input.kind,
      input.memoryKey,
      now,
    );
    const inserted = await transaction
      .insert(schema.memories)
      .values({
        memoryId,
        contactId: conversation.contactId,
        kind: input.kind,
        memoryKey: input.memoryKey,
        content: input.content,
        status: "active",
        confidence: 100,
        importance: input.importance ?? 3,
        evidenceMessageIds: [],
        extractedByModel: "manual",
        validFrom: now,
        invalidatedAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.memories.memoryId,
        set: {
          status: "active",
          confidence: 100,
          importance: input.importance ?? 3,
          extractedByModel: "manual",
          invalidatedAt: null,
          updatedAt: now,
        },
      })
      .returning();
    const memory = inserted[0];
    if (!memory) throw new Error("manual memory was not returned");
    await recordUserMemoryEvent(transaction, {
      memoryId,
      actorUserId: input.actorUserId,
      clientRequestId: input.clientRequestId,
      eventType: "created",
      conversationId: input.conversationId,
      sourceIp: input.sourceIp,
    });
    return { status: "ok", replayed: false, memory };
  });
}

/**
 * 变更记忆状态（激活或失效）
 *
 * activate: 将 candidate 状态的记忆提升为 active，并取代同类型的现有活跃记忆。
 * invalidate: 将 candidate 或 active 状态的记忆标记为 invalidated。
 * 支持幂等性校验。
 */
export async function transitionMemory(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    memoryId: string;
    actorUserId: string;
    clientRequestId: string;
    sourceIp: string;
    action: "activate" | "invalidate";
  },
): Promise<
  | {
      status: "ok";
      replayed: boolean;
      memory: typeof schema.memories.$inferSelect;
    }
  | { status: "not_found" }
  | { status: "invalid_transition" }
  | { status: "idempotency_conflict" }
> {
  return db.transaction(async (transaction) => {
    const prior = await transaction
      .select({ event: schema.memoryEvents, memory: schema.memories })
      .from(schema.memoryEvents)
      .innerJoin(
        schema.memories,
        eq(schema.memories.memoryId, schema.memoryEvents.memoryId),
      )
      .where(eq(schema.memoryEvents.clientRequestId, input.clientRequestId))
      .limit(1);
    if (prior[0]) {
      const matches =
        prior[0].event.memoryId === input.memoryId &&
        prior[0].event.eventType ===
          (input.action === "activate" ? "activated" : "invalidated") &&
        prior[0].event.metadata.conversationId === input.conversationId;
      return matches
        ? { status: "ok", replayed: true, memory: prior[0].memory }
        : { status: "idempotency_conflict" };
    }

    const rows = await transaction
      .select({ memory: schema.memories })
      .from(schema.conversations)
      .innerJoin(
        schema.memories,
        eq(schema.memories.contactId, schema.conversations.contactId),
      )
      .where(
        and(
          eq(schema.conversations.conversationId, input.conversationId),
          eq(schema.memories.memoryId, input.memoryId),
        ),
      )
      .limit(1);
    const memory = rows[0]?.memory;
    if (!memory) return { status: "not_found" };
    if (
      (input.action === "activate" && memory.status !== "candidate") ||
      (input.action === "invalidate" &&
        !["candidate", "active"].includes(memory.status))
    ) {
      return { status: "invalid_transition" };
    }

    const now = new Date();
    if (input.action === "activate") {
      await supersedeActive(
        transaction,
        memory.contactId,
        memory.kind as MemoryKind,
        memory.memoryKey,
        now,
      );
    }
    const updated = await transaction
      .update(schema.memories)
      .set({
        status: input.action === "activate" ? "active" : "invalidated",
        invalidatedAt: input.action === "invalidate" ? now : null,
        updatedAt: now,
      })
      .where(eq(schema.memories.memoryId, memory.memoryId))
      .returning();
    const result = updated[0];
    if (!result) throw new Error("memory transition did not return a row");
    await recordUserMemoryEvent(transaction, {
      memoryId: memory.memoryId,
      actorUserId: input.actorUserId,
      clientRequestId: input.clientRequestId,
      eventType: input.action === "activate" ? "activated" : "invalidated",
      conversationId: input.conversationId,
      sourceIp: input.sourceIp,
    });
    return { status: "ok", replayed: false, memory: result };
  });
}

/** 将同类型的现有活跃记忆标记为 superseded（被取代） */
async function supersedeActive(
  transaction: Parameters<
    Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
  >[0],
  contactId: string,
  kind: MemoryKind,
  memoryKey: string,
  now: Date,
): Promise<void> {
  await transaction
    .update(schema.memories)
    .set({ status: "superseded", invalidatedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.memories.contactId, contactId),
        eq(schema.memories.kind, kind),
        eq(schema.memories.memoryKey, memoryKey),
        eq(schema.memories.status, "active"),
      ),
    );
}

/** 记录用户操作的记忆事件和审计日志 */
async function recordUserMemoryEvent(
  transaction: Parameters<
    Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
  >[0],
  input: {
    memoryId: string;
    actorUserId: string;
    clientRequestId: string;
    eventType: "created" | "activated" | "invalidated";
    conversationId: string;
    sourceIp: string;
  },
): Promise<void> {
  const eventId = `memory_event_${createHash("sha256")
    .update(input.clientRequestId)
    .digest("hex")}`;
  await transaction.insert(schema.memoryEvents).values({
    eventId,
    memoryId: input.memoryId,
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    clientRequestId: input.clientRequestId,
    metadata: { conversationId: input.conversationId },
  });
  await transaction.insert(schema.auditEvents).values({
    auditId: randomUUID(),
    actorUserId: input.actorUserId,
    eventType: `memory.${input.eventType}`,
    subjectType: "memory",
    subjectId: input.memoryId,
    sourceIp: input.sourceIp,
    metadata: {
      conversationId: input.conversationId,
      clientRequestId: input.clientRequestId,
    },
  });
}

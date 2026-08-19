/**
 * 记忆捕获处理
 *
 * 执行实际的记忆提取流程：读取会话消息、调用 LLM 提取记忆候选、
 * 验证证据有效性、将有效记忆持久化到数据库。
 * 使用乐观锁防止并发处理同一会话的记忆捕获任务。
 */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { TextModel } from "../../model/contracts/text-model.js";
import * as schema from "../../../infrastructure/postgres/schema.js";
import {
  extractMemories,
  memoryIdFor,
  memoryCaptureErrorCode,
  publishedStatus,
  type ExtractedMemory,
} from "./memory-extraction.js";

/** 记忆捕获任务标识 */
export type MemoryCaptureJob = {
  conversationId: string;
  revision: number;
};

/**
 * 处理记忆捕获任务
 *
 * 通过 CAS 抢占任务后，批量读取消息并调用 LLM 提取记忆。
 * 提取结果经过证据验证后发布为持久化记忆。
 * 失败时回退状态并增加重试计数。
 */
export async function processMemoryCapture(
  db: NodePgDatabase<typeof schema>,
  modelClient: TextModel,
  model: string,
  job: MemoryCaptureJob,
  now = new Date(),
): Promise<"completed" | "stale"> {
  const claimed = await db
    .update(schema.memoryCaptureStates)
    .set({
      status: "running",
      errorCode: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.memoryCaptureStates.conversationId, job.conversationId),
        eq(schema.memoryCaptureStates.revision, job.revision),
        inArray(schema.memoryCaptureStates.status, ["scheduled", "running"]),
        lte(schema.memoryCaptureStates.scheduledAt, now),
      ),
    )
    .returning();
  const state = claimed[0];
  if (!state) return "stale";

  try {
    const batch = await captureMessages(db, state);
    const extracted =
      batch.messages.length === 0
        ? []
        : await extractMemories(modelClient, batch.messages);
    const evidenceIds = new Set(
      batch.messages.map((message) => message.messageId),
    );
    const validated = extracted.filter((memory) =>
      memory.evidenceMessageIds.every((id) => evidenceIds.has(id)),
    );
    return await publishCapture(db, state, batch, validated, model, now);
  } catch (error) {
    await db
      .update(schema.memoryCaptureStates)
      .set({
        status: "scheduled",
        attempt: state.attempt + 1,
        errorCode: memoryCaptureErrorCode(error),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.memoryCaptureStates.conversationId, state.conversationId),
          eq(schema.memoryCaptureStates.revision, state.revision),
        ),
      );
    throw error;
  }
}

/**
 * 读取待捕获的消息批次
 *
 * 使用消息水位线（watermark）和上次处理位置（lastCapturedMessageId）
 * 进行分页游标查询，最多读取 40 条消息。
 */
async function captureMessages(
  db: NodePgDatabase<typeof schema>,
  state: typeof schema.memoryCaptureStates.$inferSelect,
): Promise<{
  messages: {
    messageId: string;
    direction: string;
    actorType: string;
    text: string;
  }[];
  lastProcessedMessageId: string;
  hasMore: boolean;
}> {
  const rows = await db
    .select({
      messageId: schema.messages.messageId,
      direction: schema.messages.direction,
      actorType: schema.messages.actorType,
      text: schema.messages.text,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, state.conversationId),
        eq(schema.messages.contentType, "text"),
        sql<boolean>`(
          ${schema.messages.createdAt} < (
            select "created_at" from "conversation"."messages"
            where "message_id" = ${state.watermarkMessageId}
          )
          or (
            ${schema.messages.createdAt} = (
              select "created_at" from "conversation"."messages"
              where "message_id" = ${state.watermarkMessageId}
            )
            and ${schema.messages.messageId} <= ${state.watermarkMessageId}
          )
        )`,
        ...(state.lastCapturedMessageId
          ? [
              sql<boolean>`(
                ${schema.messages.createdAt} > (
                  select "created_at" from "conversation"."messages"
                  where "message_id" = ${state.lastCapturedMessageId}
                )
                or (
                  ${schema.messages.createdAt} = (
                    select "created_at" from "conversation"."messages"
                    where "message_id" = ${state.lastCapturedMessageId}
                  )
                  and ${schema.messages.messageId} > ${state.lastCapturedMessageId}
                )
              )`,
            ]
          : []),
      ),
    )
    .orderBy(asc(schema.messages.createdAt), asc(schema.messages.messageId))
    .limit(41);
  const messages = rows.slice(0, 40);
  return {
    messages,
    lastProcessedMessageId:
      messages.at(-1)?.messageId ?? state.watermarkMessageId,
    hasMore: rows.length > 40,
  };
}

/**
 * 发布提取的记忆到数据库
 *
 * 在事务中验证版本号后，将提取的记忆逐条写入。
 * 同类型的活跃记忆会被标记为 superseded（被取代）。
 * 更新捕获状态，如果有更多消息则重新调度。
 */
async function publishCapture(
  db: NodePgDatabase<typeof schema>,
  state: typeof schema.memoryCaptureStates.$inferSelect,
  batch: Awaited<ReturnType<typeof captureMessages>>,
  extracted: ExtractedMemory[],
  model: string,
  now: Date,
): Promise<"completed" | "stale"> {
  return db.transaction(async (transaction) => {
    const current = await transaction
      .select()
      .from(schema.memoryCaptureStates)
      .where(
        eq(schema.memoryCaptureStates.conversationId, state.conversationId),
      )
      .limit(1);
    if (
      current[0]?.revision !== state.revision ||
      current[0].status !== "running"
    ) {
      return "stale";
    }

    for (const item of extracted) {
      const proposedStatus = publishedStatus(item);
      const memoryId = memoryIdFor(
        state.contactId,
        item.kind,
        item.key,
        item.content,
      );
      const existing = await transaction
        .select()
        .from(schema.memories)
        .where(eq(schema.memories.memoryId, memoryId))
        .limit(1);
      if (existing[0]?.status === "invalidated") continue;
      const status =
        existing[0]?.status === "active" ? "active" : proposedStatus;

      if (status === "active") {
        await transaction
          .update(schema.memories)
          .set({
            status: "superseded",
            invalidatedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.memories.contactId, state.contactId),
              eq(schema.memories.kind, item.kind),
              eq(schema.memories.memoryKey, item.key),
              eq(schema.memories.status, "active"),
            ),
          );
      }

      await transaction
        .insert(schema.memories)
        .values({
          memoryId,
          contactId: state.contactId,
          kind: item.kind,
          memoryKey: item.key,
          content: item.content,
          status,
          confidence: item.confidence,
          evidenceMessageIds: [...new Set(item.evidenceMessageIds)],
          extractedByModel: model,
          validFrom: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.memories.memoryId,
          set: {
            confidence: maxConfidence(existing[0]?.confidence, item.confidence),
            evidenceMessageIds: [
              ...new Set([
                ...(existing[0]?.evidenceMessageIds ?? []),
                ...item.evidenceMessageIds,
              ]),
            ],
            status,
            invalidatedAt: null,
            updatedAt: now,
          },
        });
      await transaction
        .insert(schema.memoryEvents)
        .values({
          eventId: automaticEventId(
            state.conversationId,
            state.revision,
            memoryId,
          ),
          memoryId,
          actorUserId: null,
          eventType: "captured",
          clientRequestId: null,
          metadata: {
            conversationId: state.conversationId,
            revision: String(state.revision),
            status,
          },
        })
        .onConflictDoNothing();
    }

    await transaction
      .update(schema.memoryCaptureStates)
      .set({
        status: batch.hasMore ? "scheduled" : "completed",
        lastCapturedMessageId: batch.lastProcessedMessageId,
        revision: batch.hasMore ? state.revision + 1 : state.revision,
        scheduledAt: batch.hasMore ? now : state.scheduledAt,
        attempt: 0,
        extractedCount: state.extractedCount + extracted.length,
        errorCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.memoryCaptureStates.conversationId, state.conversationId),
          eq(schema.memoryCaptureStates.revision, state.revision),
        ),
      );
    return "completed";
  });
}

function maxConfidence(prior: number | undefined, current: number): number {
  return Math.max(prior ?? 0, current);
}

function automaticEventId(
  conversationId: string,
  revision: number,
  memoryId: string,
): string {
  return `memory_event_${createHash("sha256")
    .update(`${conversationId}\0${String(revision)}\0${memoryId}`)
    .digest("hex")}`;
}

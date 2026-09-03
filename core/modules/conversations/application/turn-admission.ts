/**
 * 合并窗口（Turn Admission）纯逻辑：半句启发式 + 收窗时刻计算。
 *
 * 消息准入时不再立即建 Turn，而是登记进合并窗口；窗口到点（静默足够
 * 久且最后一条不似半句）才由 dispatcher 合并建 Turn。运行时优先级与
 * 兜底原则：窗口参数缺失/类型不符一律回落默认值，绝不阻断消息处理。
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, lte, sql } from "drizzle-orm";
import * as schema from "../../../infrastructure/postgres/schema.js";

/** 常见"话说一半/没说完"的结尾特征。 */
const UNFINISHED_TAIL_RE =
  /(?:你知道|等一下|我跟你讲|其实吧|但是|所以说|然后|那个|就是|我想说|对了|等我|等等|我看看|还有|再说|主要是|毕竟|因为|所以|但是吧|回头|回头说|待会|晚点|等会|再说吧)$/;

/** 以中文逗号/顿号/分号/冒号等"非终止标点"结尾，也常表示还没说完。 */
const UNFINISHED_PUNCT_RE = /[，、；：,;:]$/;

/** 明确以终止标点/省略号结尾的消息视为说完。 */
const FINISHED_TAIL_RE = /[。！？!?…～~]+$/;

/** 判断一条消息文本是否"话没说完"（用于延长合并窗口）。 */
export function looksLikeUnfinished(text: unknown): boolean {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return false;
  if (FINISHED_TAIL_RE.test(s)) return false;
  if (UNFINISHED_TAIL_RE.test(s)) return true;
  if (UNFINISHED_PUNCT_RE.test(s)) return true;
  return false;
}

/** 出厂默认静默窗：普通消息 12 秒。 */
export const DEFAULT_QUIET_WINDOW_MS = 12_000;

/** 半句未完时的延长窗：最多再等到 30 秒。 */
export const MAX_ADMISSION_WINDOW_MS = 30_000;

/** 收窗时刻：未半句化为基准窗，半句化延长窗；参数异常回落默认。 */
export function nextAdmissionAt(input: {
  text: unknown;
  now: Date;
  quietWindowMs?: unknown;
  unfinishedWindowMs?: unknown;
}): Date {
  const baseMs = toPositiveInt(input.quietWindowMs, DEFAULT_QUIET_WINDOW_MS);
  const extendMs = toPositiveInt(
    input.unfinishedWindowMs,
    MAX_ADMISSION_WINDOW_MS,
  );
  const delayMs = looksLikeUnfinished(input.text)
    ? Math.max(baseMs, extendMs)
    : baseMs;
  return new Date(input.now.getTime() + delayMs);
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? Math.round(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 合并窗口登记行（表结构见 migration：turn_admission_states）。 */
export type TurnAdmissionInput = {
  conversationId: string;
  contactId: string;
  messageId: string;
  text: unknown;
  now: Date;
  quietWindowMs?: unknown;
  unfinishedWindowMs?: unknown;
  /** 窗内重置时传入现有 revision（本次 +1）；首条不传按 1 计。 */
  existingRevision?: number | undefined;
  /** 窗内已有消息条数（含首条）；首条不传按 0 计。 */
  existingCount?: number | undefined;
};

/**
 * 登记一条消息进合并窗口（照 memoryCaptureStates 家法：一会话一行，
 * 新消息 upsert 重置窗口、revision+1、清错误）。调用方负责事务内执行。
 */
export async function scheduleTurnAdmission(
  db: NodePgDatabase<typeof schema>,
  input: TurnAdmissionInput,
): Promise<void> {
  const scheduledAt = nextAdmissionAt({
    text: input.text,
    now: input.now,
    quietWindowMs: input.quietWindowMs,
    unfinishedWindowMs: input.unfinishedWindowMs,
  });
  const existingRevision =
    typeof input.existingRevision === "number" && input.existingRevision > 0
      ? input.existingRevision
      : 0;
  const existingCount =
    typeof input.existingCount === "number" && input.existingCount > 0
      ? input.existingCount
      : 0;
  await db
    .insert(schema.turnAdmissionStates)
    .values({
      conversationId: input.conversationId,
      contactId: input.contactId,
      lastMessageId: input.messageId,
      messageCount: existingCount + 1,
      revision: existingRevision + 1,
      status: "scheduled",
      scheduledAt,
    })
    .onConflictDoUpdate({
      target: schema.turnAdmissionStates.conversationId,
      set: {
        contactId: input.contactId,
        lastMessageId: input.messageId,
        messageCount: existingCount + 1,
        revision: sql`${schema.turnAdmissionStates.revision} + 1`,
        status: "scheduled",
        scheduledAt,
        attempt: 0,
        errorCode: null,
        updatedAt: input.now,
      },
    });
}

/** dispatcher CAS 认领成功后拿到的窗口快照。 */
export type ClaimedAdmission = {
  conversationId: string;
  contactId: string;
  lastMessageId: string;
  messageCount: number;
  revision: number;
  status: string;
};

/**
 * 认领一条到期登记（照 processMemoryCapture 家法）：仅当
 * conversation+revision 匹配、状态 scheduled、且已到期时置为
 * dispatching 并返回快照；否则返回 null（stale，多实例/过期唤醒安全）。
 * 调用方据此合并窗内消息建 turn；失败时回写 scheduled/attempt+1 重试。
 */
export async function claimDueTurnAdmission(
  db: NodePgDatabase<typeof schema>,
  input: { conversationId: string; revision: number; now: Date },
): Promise<ClaimedAdmission | null> {
  const claimed = await db
    .update(schema.turnAdmissionStates)
    .set({ status: "dispatching", errorCode: null, updatedAt: input.now })
    .where(
      and(
        eq(schema.turnAdmissionStates.conversationId, input.conversationId),
        eq(schema.turnAdmissionStates.revision, input.revision),
        eq(schema.turnAdmissionStates.status, "scheduled"),
        lte(schema.turnAdmissionStates.scheduledAt, input.now),
      ),
    )
    .returning();
  const row = claimed[0];
  if (!row) return null;
  return {
    conversationId: String(row.conversationId),
    contactId: String(row.contactId),
    lastMessageId: String(row.lastMessageId),
    messageCount: Number(row.messageCount ?? 0),
    revision: Number(row.revision ?? 0),
    status: String(row.status),
  };
}

/** 事务内登记（ingest 准入分支调用；签名对齐 scheduleMemoryCaptureInTransaction）。 */
export function scheduleTurnAdmissionInTransaction(
  transaction: Parameters<typeof scheduleTurnAdmission>[0],
  input: TurnAdmissionInput,
): Promise<void> {
  return scheduleTurnAdmission(transaction, input);
}

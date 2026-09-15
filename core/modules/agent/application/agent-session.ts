/**
 * Agent 会话片段（Session Episode）状态机（Phase 3）。
 *
 * 会话模式把代理的单位从「消息回合」升级为「会话片段」：接起一段
 * 对话，期间等待/过滤/查证，直到解决或转人工才放手。连续性活在
 * 数据模型（agent_sessions 状态行）里，不活在进程里——每轮仍走
 * 既有的 CAS 领取 + 检查点执行。
 *
 * 状态：active（接待中）→ waiting（等客户）→ closed（收尾）
 * 预算与闸门由代码持有（本模块判定），模型只在预算内自由决策。
 */
import { and, desc, eq, inArray, like, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

/** 出厂默认会话 TTL：45 分钟。 */
export const DEFAULT_SESSION_TTL_MS = 45 * 60_000;

/** 每会话轮数上限（代码持有的预算闸门之一）。 */
export const MAX_ROUNDS_PER_SESSION = 24;

export type AgentSessionState = "active" | "waiting" | "closed";

export type SessionStateSnapshot = {
  state: AgentSessionState;
  roundsUsed: number;
  roundBudget: number;
  startedAt: Date;
  now: Date;
  agentPaused: boolean;
  agentEnabled: boolean;
  ttlMs?: number | undefined;
};

export type SessionTransition =
  | { action: "continue" }
  | {
      action: "force_close";
      reason: "session_ttl_exceeded" | "round_budget_exhausted";
    }
  | {
      action: "freeze";
      reason: "handoff_active" | "agent_disabled" | "session_closed";
    };

/**
 * 每轮开头的强制判定（代码持有，模型不可绕过）：
 * - Handoff 冻结与自动回复关闭优先于一切（人工在线时 AI 立即静默）；
 * - TTL/轮数到线强制收束（生成摘要关会话），防「永不结束的会话」。
 */
export function decideSessionTransition(
  snapshot: SessionStateSnapshot,
): SessionTransition {
  if (snapshot.state === "closed") {
    return { action: "freeze", reason: "session_closed" };
  }
  if (snapshot.agentPaused) {
    return { action: "freeze", reason: "handoff_active" };
  }
  if (!snapshot.agentEnabled) {
    return { action: "freeze", reason: "agent_disabled" };
  }
  const ttlMs = snapshot.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  if (snapshot.now.getTime() - snapshot.startedAt.getTime() >= ttlMs) {
    return { action: "force_close", reason: "session_ttl_exceeded" };
  }
  if (snapshot.roundsUsed >= snapshot.roundBudget) {
    return { action: "force_close", reason: "round_budget_exhausted" };
  }
  return { action: "continue" };
}

/**
 * 关闭会话最近一个未收尾的片段（end_session 决策的落库形态）。
 * 没有 open 片段时是空操作（end_session 幂等；closed 片段不复活）。
 */
export async function closeAgentSession(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    closureSummary: string;
    now: Date;
  },
): Promise<void> {
  const open = await db
    .select({ sessionId: schema.agentSessions.sessionId })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.conversationId, input.conversationId),
        ne(schema.agentSessions.state, "closed"),
      ),
    )
    .orderBy(desc(schema.agentSessions.startedAt))
    .limit(1);
  if (open.length === 0) return;
  await db
    .update(schema.agentSessions)
    .set({
      state: "closed",
      closedAt: input.now,
      closureSummary: input.closureSummary,
      updatedAt: input.now,
    })
    .where(
      inArray(
        schema.agentSessions.sessionId,
        open.map((row) => row.sessionId),
      ),
    );
}

// ---------------------------------------------------------------------------
// 群聊对话线程（Group Thread）：@ 开线 → 开放地板跟进 → 模型自主收线。
// 线程行复用 agent_sessions，sessionId 固定前缀 `session:group-thread:`
// 与私聊等待片段隔离；TTL 语义 = startedAt 起算的空闲超时（每次准入续期）。
// ---------------------------------------------------------------------------

/** 群聊线程行的 sessionId 前缀（闸门查询据此隔离线程与私聊片段）。 */
export const GROUP_THREAD_SESSION_PREFIX = "session:group-thread:";

/** 连接或事务均可（摄取闸门在摄取事务内调用）。 */
type SessionDatabase =
  | NodePgDatabase<typeof schema>
  | Parameters<
      Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
    >[0];

/** 查询某群当前活跃线程（未关闭且未超空闲 TTL 的最新线程行）。 */
async function findOpenGroupThread(
  db: SessionDatabase,
  input: { conversationId: string; now: Date; ttlMinutes: number },
) {
  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.conversationId, input.conversationId),
        like(
          schema.agentSessions.sessionId,
          `${GROUP_THREAD_SESSION_PREFIX}%`,
        ),
        ne(schema.agentSessions.state, "closed"),
      ),
    )
    .orderBy(desc(schema.agentSessions.startedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  const ttlMs = input.ttlMinutes * 60_000;
  if (input.now.getTime() - row.startedAt.getTime() >= ttlMs) return undefined;
  if (row.roundsUsed >= row.roundBudget) return undefined;
  return row;
}

/** 群线程是否存活（开放地板：存活期内任何群成员消息免 @ 建轮）。 */
export async function isGroupThreadOpen(
  db: SessionDatabase,
  input: { conversationId: string; now: Date; ttlMinutes: number },
): Promise<boolean> {
  if (input.ttlMinutes <= 0) return false;
  try {
    return (
      (await findOpenGroupThread(db, {
        conversationId: input.conversationId,
        now: input.now,
        ttlMinutes: input.ttlMinutes,
      })) !== undefined
    );
  } catch {
    // 查询失败按无线程处理：@ 依然能触发，宁可少回不滥回
    return false;
  }
}

/**
 * 开线或续期：@ 命中 / 跟进准入时调用。已有活跃线程 → 续期（刷新
 * startedAt = 空闲超时重置）并计一轮；没有 → 新建 active 线程行。
 * closed 线程不复活（开新行，主键带时间戳天然不冲突）。
 */
export async function ensureGroupThreadSession(
  db: SessionDatabase,
  input: { conversationId: string; now: Date; ttlMinutes: number },
): Promise<void> {
  if (input.ttlMinutes <= 0) return;
  const open = await findOpenGroupThread(db, {
    conversationId: input.conversationId,
    now: input.now,
    ttlMinutes: input.ttlMinutes,
  });
  if (open) {
    await db
      .update(schema.agentSessions)
      .set({
        startedAt: input.now,
        state: "active",
        roundsUsed: open.roundsUsed + 1,
        updatedAt: input.now,
      })
      .where(eq(schema.agentSessions.sessionId, open.sessionId));
    return;
  }
  await db
    .insert(schema.agentSessions)
    .values({
      sessionId: `${GROUP_THREAD_SESSION_PREFIX}${input.conversationId}:${String(
        input.now.getTime(),
      )}`,
      conversationId: input.conversationId,
      state: "active",
      roundsUsed: 1,
      startedAt: input.now,
    })
    .onConflictDoNothing();
}

/** 模型 end_session 时收线：关闭该群全部开放线程（幂等，没有则空操作）。 */
export async function closeGroupThreadSessions(
  db: SessionDatabase,
  input: { conversationId: string; now: Date },
): Promise<void> {
  await db
    .update(schema.agentSessions)
    .set({ state: "closed", closedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(schema.agentSessions.conversationId, input.conversationId),
        like(
          schema.agentSessions.sessionId,
          `${GROUP_THREAD_SESSION_PREFIX}%`,
        ),
        ne(schema.agentSessions.state, "closed"),
      ),
    );
}

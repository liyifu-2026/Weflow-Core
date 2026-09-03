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
  | { action: "force_close"; reason: "session_ttl_exceeded" | "round_budget_exhausted" }
  | {
      action: "freeze";
      reason:
        | "handoff_active"
        | "agent_disabled"
        | "session_closed";
    };

/**
 * 每轮开头的强制判定（代码持有，模型不可绕过）：
 * - Handoff 冻结与白名单摘除优先于一切（人工在线时 AI 立即静默）；
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

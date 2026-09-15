/**
 * Agent 轮次调度策略
 * 定义"一个会话何时可以开始新的 Agent 工作"的业务决策：
 * - 静默窗口合并（同一会话的多个排队轮次只保留最新）
 * - 待回复 Agent 回复的排除窗口
 * - 运行中轮次的崩溃失效阈值
 * 纯决策逻辑，不依赖数据库、Redis 或运行时；分发器等执行方引用本模块。
 */

/** 静默窗口时间（毫秒），在此窗口内的多个轮次会被合并 */
export const AGENT_TURN_QUIET_WINDOW_MS = 1_500;

/**
 * 待发送 Agent 回复的排除窗口（毫秒）。
 * dispatcher 会跳过存在"最近窗口内"未确认 Agent 回复的会话，
 * 避免与正在发出的回复叠加；超过窗口的 pending/unknown 消息视为
 * 渠道确认丢失的死消息，不再阻塞该会话的新轮次。
 */
export const AGENT_PENDING_REPLY_WINDOW_MS = 10 * 60_000;

/**
 * 运行中或工具待执行轮次被视为崩溃失效的时长阈值（毫秒）。
 * 90s：worker 内每一步都有独立超时（决策 decisionTimeoutMs、工具 15s），
 * 且每次续步都会刷新 startedAt——正常长循环不会误伤；而 2026-09-07
 * 实测 5min 阈值下 turn 假死要陪葬整整 5 分钟才被回收，客户侧不可接受。
 */
export const STALE_RUNNING_TURN_MS = 90 * 1_000;

/** 视为"待确认回复"的出站发送状态；处于这些状态的回复阻塞新轮次。
 *  与出站循环扫描集同源定义（send-states），漂移在此处即编译失败。 */
export { OUTBOUND_LOOP_SEND_STATES as PENDING_AGENT_REPLY_SEND_STATES } from "./send-states.js";

/** 排队中的 Agent 轮次 */
export type QueuedAgentTurn = {
  turnId: string;
  conversationId: string;
  traceId: string;
  createdAt: Date;
  /**
   * 触发消息的发送时间（dispatcher join messages 提供；wake 轮无触发消息为 null）。
   * 「谁是最新轮次」以它为准——与 worker 侧 findNewerActiveTurnIds 同一把尺子。
   */
  triggerOccurredAt?: Date | null;
};

/**
 * 合并排队的 Agent 轮次
 * 同一会话只保留最新轮次，旧轮次标记为 superseded
 * 仅当最新轮次超过静默窗口后才标记为 ready
 */
export function coalesceQueuedAgentTurns(
  turns: QueuedAgentTurn[],
  now: Date,
  quietWindowMs = AGENT_TURN_QUIET_WINDOW_MS,
): { ready: QueuedAgentTurn[]; superseded: QueuedAgentTurn[] } {
  const byConversation = new Map<string, QueuedAgentTurn[]>();
  for (const turn of turns) {
    const conversationTurns = byConversation.get(turn.conversationId) ?? [];
    conversationTurns.push(turn);
    byConversation.set(turn.conversationId, conversationTurns);
  }

  const ready: QueuedAgentTurn[] = [];
  const superseded: QueuedAgentTurn[] = [];
  for (const conversationTurns of byConversation.values()) {
    conversationTurns.sort(compareTurns);
    const latest = conversationTurns.at(-1);
    if (!latest) continue;
    superseded.push(...conversationTurns.slice(0, -1));
    if (now.getTime() - latest.createdAt.getTime() >= quietWindowMs) {
      ready.push(latest);
    }
  }
  ready.sort(compareTurns);
  return { ready, superseded };
}

/** 运行中轮次的失效分界点：startedAt 早于该时间的轮次视为 worker 崩溃遗留。 */
export function staleRunningTurnBefore(now: Date): Date {
  return new Date(now.getTime() - STALE_RUNNING_TURN_MS);
}

/** 待回复排除窗口起点：occurredAt 晚于该时间的未确认 Agent 回复阻塞新轮次。 */
export function pendingReplyWindowStart(now: Date): Date {
  return new Date(now.getTime() - AGENT_PENDING_REPLY_WINDOW_MS);
}

function compareTurns(left: QueuedAgentTurn, right: QueuedAgentTurn): number {
  // 「最新」以触发消息时间为准（与 findNewerActiveTurnIds 同尺）；turn 行创建时间
  // 只作 tiebreak。两者在摄取乱序时会相反：曾实测同会话双消息，合并按行创建
  // 时间留下的幸存者恰被 superseded 闸门按消息时间处决——双双 superseded，
  // 客户收不到任何回复。无触发消息的 wake 轮排最旧（新消息进来时让位）。
  const leftTrigger = left.triggerOccurredAt?.getTime();
  const rightTrigger = right.triggerOccurredAt?.getTime();
  const trigger =
    (leftTrigger ?? Number.NEGATIVE_INFINITY) -
    (rightTrigger ?? Number.NEGATIVE_INFINITY);
  if (trigger !== 0) return trigger;
  const createdAt = left.createdAt.getTime() - right.createdAt.getTime();
  return createdAt === 0 ? left.turnId.localeCompare(right.turnId) : createdAt;
}

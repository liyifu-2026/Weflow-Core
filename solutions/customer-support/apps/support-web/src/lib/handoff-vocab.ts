/**
 * Handoff 展示词汇表（Handoff Presentation Vocabulary）。
 *
 * Core 的 Handoff 事实以多种方言到达前端（contract 小写状态、Mobile 序列化
 * 大写值、cycle 历史词汇），这里是它们到 UI 单一词汇的唯一投影点：
 * 归一化、标签文案、按钮可见性（capability 关闭时的本地推导回退）、
 * Composer 派生文案。全部纯函数。
 *
 * 与 types.ts 的分工：types.ts 是「会话工作台共享类型与消息渲染纯函数」，
 * 本文件是「Handoff 生命周期」的展示语义——改 Handoff 文案/按钮规则只来这里。
 */

/** Core 对 contractVersion=2 会话返回 Mobile 序列化的状态大写值，
 * 桌面端状态判断统一用小写；进入 UI 前归一化，避免“按钮存在却永远不显示”。 */
const HANDOFF_STATUS_NORMALIZE: Record<string, string> = {
  HANDOFF_PENDING: "pending",
  TRANSFER_PENDING: "transfer_pending",
  HUMAN_ACTIVE: "in_progress",
  HUMAN_FINISHED: "resolved",
};

export function normalizeHandoffStatus(status?: string | null): string | undefined {
  if (!status) return undefined;
  return HANDOFF_STATUS_NORMALIZE[status] ?? status;
}

/** 归一化后的 Handoff 状态（视图里 state 来自 Core 投影，字段保持宽松） */
export type HandoffStateLike = {
  status?: string | null;
  assignedUserId?: string;
  targetQueueId?: string;
  targetDisplayName?: string;
  handoffRevision?: number;
} | null | undefined;

export function handoffLabel(status?: string): string {
  return status === "pending"
    ? "等待接手"
    : status === "in_progress"
      ? "处理中"
      : status === "resolved"
        ? "已完成"
        : "Agent 处理中";
}

export function ownershipLabel(state: HandoffStateLike, isMine: boolean): string {
  if (!state) return "Agent 处理中";
  if (state.status === "pending") return "等待接手";
  if (state.status === "in_progress")
    return isMine ? "我处理中" : "其他客服处理中";
  if (state.status === "resolved") return "已完成";
  return handoffLabel(state.status ?? undefined);
}

/** 转交等待文案：非 transfer_pending 返回 null（调用方据此隐藏提示条） */
export function transferPendingLabel(state: HandoffStateLike): string | null {
  if (state?.status !== "transfer_pending") return null;
  return state.targetQueueId
    ? `已进入队列${state.targetDisplayName ? `（${state.targetDisplayName}）` : ""}，等待成员接手`
    : `等待 ${state.targetDisplayName || "目标客服"} 接受`;
}

export function composerPlaceholder(state: HandoffStateLike, isMine: boolean): string {
  if (state?.status === "pending") return "先领取会话，再回复客户";
  if (state?.status === "in_progress" && !isMine) return "其他客服正在处理";
  return "输入回复…";
}

export function composerDisabled(state: HandoffStateLike, isMine: boolean): boolean {
  return state?.status === "in_progress" && !isMine;
}

// ---------- capability 关闭时的本地推导回退（服务端 permissions 缺失即只读） ----------

/** AGENT_ACTIVE 才能 Manual Takeover（仅 AGENT_ACTIVE 即无 handoff 时显示接管条） */
export function canManualTakeoverFallback(hasHandoff: boolean): boolean {
  return !hasHandoff;
}

export function canTransferFallback(isMine: boolean): boolean {
  return isMine;
}

export function canFinishFallback(isMine: boolean): boolean {
  return isMine;
}

/** pending 必须先领取；他人处理中的会话不可回复 */
export function canReplyFallback(
  replyText: string,
  state: HandoffStateLike,
  isMine: boolean,
): boolean {
  return Boolean(
    replyText.trim() &&
      state?.status !== "pending" &&
      !(state?.status === "in_progress" && !isMine),
  );
}

/** cycle 历史（转接链）展示词汇：Mobile 大写枚举 → 文案 */
export function cycleStatusLabel(status?: string): string {
  const map: Record<string, string> = {
    HANDOFF_PENDING: "等待处理",
    HANDOFF_ACCEPTED: "已接管",
    HANDOFF_RESOLVED: "已结束",
    TRANSFER_PENDING: "转交等待接受",
    TRANSFERRED: "已转交",
    AGENT_HANDOFF: "Agent 转人工",
  };
  return map[String(status).toUpperCase()] ?? status ?? "交接";
}

/**
 * 发送状态词汇表 —— `messages.send_state` 的唯一权威定义。
 *
 * 曾有 ≥9 个持久态散落在两仓 10+ 处、无任何模块拥有，已发生三处漂移
 * （confirmed 报成 accepted、round-window 漏 submitting、前端渲染幻影态）。
 * 本模块收口：全部集合/谓词/host 映射/投递投影只在此定义；
 * 新增状态 = 改这里 + SEND_STATES 集合 + 迁移 CHECK 约束，编译期与库约束双保险。
 *
 * 状态全集（0075 迁移起受 CHECK 约束；`sent`/`sending` 为历史幻影态，
 * 从未持久化，仅剩投影/展示层兼容引用）：
 * - pending      已落库待发送（唯一可被取消的态）
 * - submitting   已分配 operationId，在途对账中（host 的 pending/executing 映射到这）
 * - observed     出站消息被通道回声观察到（自消息回采；视为已送达）
 * - confirmed    host 确认送达 / 回声融合绑定成功
 * - failed       host 拒收或发送失败（终态）
 * - unknown      对账丢失，无法确认结果（终态；同 key 重试无效，须补发）
 * - held         kill switch 拦截（终态；恢复开关后不自动补发）
 * - cancelled    转人工/策略停用取消待发消息（终态；原因在 send_error）
 */
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { ChannelSendOperationState } from "../../channel/contracts/channel-send-operations.js";

/** 独立连接或事务句柄皆可（取消总是发生在宿主事务内）。 */
type DatabaseTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

export const SEND_STATES = [
  "pending",
  "submitting",
  "observed",
  "confirmed",
  "failed",
  "unknown",
  "held",
  "cancelled",
] as const;

export type SendState = (typeof SEND_STATES)[number];

/** 单态常量：SQL eq()/insert 的字面量统一从此引用，杜绝拼写漂移。 */
export const SEND_STATE = {
  pending: "pending",
  submitting: "submitting",
  observed: "observed",
  confirmed: "confirmed",
  failed: "failed",
  unknown: "unknown",
  held: "held",
  cancelled: "cancelled",
} as const satisfies Record<SendState, SendState>;

/**
 * 出站循环驱动集：出站轮询扫描的态 = 会阻塞同会话新 Agent 轮次的
 * 「待回复」态。两个消费方曾各自手写同一定义（漂移温床），现同源。
 */
export const OUTBOUND_LOOP_SEND_STATES = [
  SEND_STATE.pending,
  SEND_STATE.submitting,
  SEND_STATE.unknown,
] as const;

/** 在途集：仍可能被前序分段阻塞/正在发出的态。 */
export const IN_FLIGHT_SEND_STATES = [
  SEND_STATE.pending,
  SEND_STATE.submitting,
] as const;

/** 已送达集：通道已看到或已确认。 */
export const DELIVERED_SEND_STATES = [
  SEND_STATE.confirmed,
  SEND_STATE.observed,
] as const;

export function isDeliveredSendState(state: string | null): boolean {
  return (
    state === SEND_STATE.confirmed || state === SEND_STATE.observed
  );
}

/**
 * Host 协议状态（5 态）→ Core 持久态的唯一映射点。
 * executing（host 已认领、GUI 发送中）与 pending 一样属于在途，
 * 一律映射 submitting——不得把在途误报为已发送或失败。
 */
export function sendStateFromHost(
  state: ChannelSendOperationState,
): SendState {
  switch (state) {
    case "pending":
    case "executing":
      return SEND_STATE.submitting;
    case "confirmed":
      return SEND_STATE.confirmed;
    case "failed":
      return SEND_STATE.failed;
    case "unknown":
      return SEND_STATE.unknown;
  }
}

/**
 * 人工回复投递投影：把持久态映射为面向坐席的结果语义。
 * confirmed/observed = 已送达（曾落到 catch-all「已受理」——已确认送达
 * 被谎报为受理）；held/cancelled 显式呈现，不再混入 accepted。
 * `sent` 为历史幻影态兼容；空/未知值保守视为已受理（发送链路已接手）。
 */
export const MANUAL_REPLY_DELIVERY_STATUSES = [
  "pending",
  "accepted",
  "sent",
  "failed",
  "unknown",
  "held",
  "cancelled",
] as const;

export type ManualReplyDeliveryStatus =
  (typeof MANUAL_REPLY_DELIVERY_STATUSES)[number];

export function projectDeliveryStatus(
  sendState: string | null | undefined,
): ManualReplyDeliveryStatus {
  const state = sendState ?? null;
  if (isDeliveredSendState(state) || state === "sent") {
    return "sent";
  }
  if (state === SEND_STATE.submitting) return "accepted";
  if (state === SEND_STATE.pending) return "pending";
  if (state === SEND_STATE.unknown) return "unknown";
  if (state === SEND_STATE.failed) return "failed";
  if (state === SEND_STATE.held) return "held";
  if (state === SEND_STATE.cancelled) return "cancelled";
  return "accepted";
}

/**
 * 取消会话中全部待发送的 Agent 消息（转人工激活 / 联系人停用或拉黑）。
 * 曾是 handoff-service 与 contact-profile-service 里两条字节级相似的
 * UPDATE 复制；原因统一写 send_error，状态一律 cancelled。
 */
export async function cancelPendingAgentOutbound(
  db: DatabaseTransaction,
  conversationId: string,
  sendError: string,
): Promise<void> {
  await db
    .update(schema.messages)
    .set({
      sendState: SEND_STATE.cancelled,
      sendError,
      sendUpdatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.actorType, "agent"),
        eq(schema.messages.sendState, SEND_STATE.pending),
      ),
    );
}

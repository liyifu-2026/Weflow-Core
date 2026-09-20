/**
 * Handoff 会话事件发布（application 层）。
 *
 * 事件只用于触发客户端失效并回拉权威状态，不承载业务事实本身；
 * 发布由 interface 的成功路径调用，事件推导不泄漏到 HTTP 适配器。
 */
import {
  conversationEvents,
  type ConversationEvent,
} from "../../../infrastructure/events/conversation-events.js";
import type { HandoffResult } from "./handoff-service.js";
import type { claimMobileHandoff } from "./mobile-handoff-service.js";

type HandoffOutcome =
  | Awaited<ReturnType<typeof claimMobileHandoff>>
  | HandoffResult;

type HandoffRef = { conversationId?: string; status?: string };

/** 根据 handoff 操作结果发布会话事件；仅成功结果发布 */
export function publishHandoffEvent(
  result: HandoffOutcome,
  eventTypeOverride?: "ownership_changed",
): void {
  if (result.status !== "ok") return;
  const handoff: HandoffRef | undefined =
    "handoff" in result
      ? result.handoff
      : (result as { handoff?: HandoffRef }).handoff;
  if (!handoff?.conversationId) return;
  conversationEvents.publish({
    type: handoffEventType(handoff.status, eventTypeOverride),
    conversationId: handoff.conversationId,
    occurredAt: new Date().toISOString(),
  });
}

/** Handoff 状态 → 会话事件类型 */
function handoffEventType(
  status: string | undefined,
  override?: "ownership_changed",
): ConversationEvent["type"] {
  if (override) return override;
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "pending" || normalized === "handoff_pending")
    return "handoff_created";
  if (normalized === "in_progress" || normalized === "human_active")
    return "handoff_claimed";
  if (normalized === "transfer_pending") return "handoff_transferred";
  if (normalized === "resolved" || normalized === "human_finished")
    return "handoff_finished";
  return "conversation_updated";
}

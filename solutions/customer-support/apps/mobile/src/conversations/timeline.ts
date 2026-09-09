/**
 * 聊天时间线合并模块
 * 处理本地消息列表与服务端返回消息的合并，支持分页加载和实时更新。
 * 已有的本地消息（如发送中的）会被服务端数据覆盖更新：
 * 服务端回执带同一 clientRequestId 时，local: 前缀的乐观消息会被移除，
 * 以服务端权威消息为准（避免发送后出现双重气泡）。
 *
 * 无变化时返回原数组引用，调用方据此跳过 setState 与重渲染——因此可以
 * 无条件调用（不依赖「revision 是否变化」这类推断，避免漏掉不改版本号的
 * 更新，如 sendState 迁移、媒体转写回填）。
 */
import type { ServerMessage } from "./api";

type MessageWithLocalId = ServerMessage & { clientRequestId?: string };

/** 合并两批消息列表，按时间排序；messageId 相同且内容有变才替换（未变保留原引用），
 * 且服务端消息会顶替同 clientRequestId 的本地乐观消息 */
export function mergeTimelineMessages<T extends MessageWithLocalId>(
  current: T[],
  incoming: T[],
): T[] {
  const byId = new Map(current.map((message) => [message.messageId, message]));
  let changed = false;
  for (const message of incoming) {
    // 乐观消息对账：服务端已落库（同 clientRequestId）→ 移除 local: 占位
    if (message.clientRequestId) {
      const localId = `local:${message.clientRequestId}`;
      const local = byId.get(localId);
      if (local && local.messageId.startsWith("local:")) {
        byId.delete(localId);
        changed = true;
      }
    }
    const existing = byId.get(message.messageId);
    if (!existing) {
      byId.set(message.messageId, message);
      changed = true;
      continue;
    }
    if (messagesDiffer(existing, message)) {
      byId.set(message.messageId, { ...existing, ...message });
      changed = true;
    }
  }
  if (!changed) return current;
  return [...byId.values()].sort(
    (first, second) =>
      new Date(first.occurredAt).getTime() - new Date(second.occurredAt).getTime(),
  );
}

/** 判断服务端消息与本地已知行是否存在需要就地更新的差异 */
export function messagesDiffer(
  known: MessageWithLocalId,
  incoming: MessageWithLocalId,
): boolean {
  const knownRecord = known as Record<string, unknown>;
  const incomingRecord = incoming as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(knownRecord),
    ...Object.keys(incomingRecord),
  ]);
  for (const key of keys) {
    if (!valuesEqual(knownRecord[key], incomingRecord[key])) return true;
  }
  return false;
}

/** 标量按 Object.is；对象/数组按 JSON 比较（每次刷新都是新引用，不能用 ===） */
function valuesEqual(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (typeof first !== "object" || typeof second !== "object") return false;
  return JSON.stringify(first) === JSON.stringify(second);
}

/** 统计 incoming 中不在 current 里的新消息数量（按 messageId 或 clientRequestId 去重；
 * 本地乐观消息对应的 server 回执不计为新消息） */
export function countNewTimelineMessages<T extends MessageWithLocalId>(
  current: T[],
  incoming: T[],
): number {
  const known = new Set(current.map((message) => message.messageId));
  const knownRequestIds = new Set(
    current
      .map((message) => message.clientRequestId)
      .filter((value): value is string => Boolean(value)),
  );
  return incoming.filter(
    (message) =>
      !known.has(message.messageId) &&
      !(
        message.clientRequestId &&
        knownRequestIds.has(message.clientRequestId)
      ),
  ).length;
}

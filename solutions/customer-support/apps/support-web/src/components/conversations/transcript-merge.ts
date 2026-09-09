/**
 * 转录增量合并（纯函数）
 *
 * 把服务端返回的最新一页消息合并进本地时间线：
 * - 新行进入 appended，由调用方决定追加还是只累加角标（取决于是否在底部）；
 * - 已有行按字段差异就地打补丁（sendState 迁移、媒体转写/描述回填），
 *   未变更的行保持原对象引用，避免整列表重渲染。
 */
import type { Message } from "./types";

export type TranscriptMergeResult = {
  /** 已应用补丁的本地时间线（顺序不变，未变更行引用不变） */
  messages: Message[];
  /** 服务端有、本地没有的新行（按服务端顺序） */
  appended: Message[];
  /** 就地更新的行数 */
  patchedCount: number;
};

/** 合并最新一页消息到本地时间线。 */
export function mergeTranscriptMessages(
  current: Message[],
  incoming: Message[],
): TranscriptMergeResult {
  const knownById = new Map(current.map((item) => [item.messageId, item]));
  const appended: Message[] = [];
  const patched = new Map<string, Message>();
  for (const item of incoming) {
    const known = knownById.get(item.messageId);
    if (!known) {
      appended.push(item);
      continue;
    }
    if (messagesDiffer(known, item))
      patched.set(item.messageId, { ...known, ...item });
  }
  return {
    messages:
      patched.size === 0
        ? current
        : current.map((item) => patched.get(item.messageId) ?? item),
    appended,
    patchedCount: patched.size,
  };
}

/** 判断服务端消息与本地已知行是否存在需要就地更新的差异。 */
export function messagesDiffer(known: Message, incoming: Message): boolean {
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

/** 标量按 Object.is；对象/数组按 JSON 比较（每次刷新都是新引用，不能用 ===）。 */
function valuesEqual(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (typeof first !== "object" || typeof second !== "object") return false;
  return JSON.stringify(first) === JSON.stringify(second);
}

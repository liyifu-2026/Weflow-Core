/**
 * 交接摘要已读状态模块
 * 按 accountId + conversationId + cycleId 记录"是否已阅读过当前 Brief"，
 * 用于决定再次进入时默认折叠（首次进入默认 compact，Cycle 变化后重新视为未读）。
 * 本地存储，不涉及服务端状态。
 */
import { sensitiveStorage } from "@/storage/sensitive-storage";

const BRIEF_READ_KEY = "weflow.mobile.brief-read-state";
const MAX_RECORDS = 200;

type BriefReadMap = Record<string, string>;

function recordKey(
  accountId: string,
  conversationId: string,
  cycleId: string,
): string {
  return `${accountId}\u0000${conversationId}\u0000${cycleId}`;
}

async function loadMap(): Promise<BriefReadMap> {
  const serialized = await sensitiveStorage.getItemAsync(BRIEF_READ_KEY);
  if (!serialized) return {};
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as BriefReadMap) : {};
  } catch {
    return {};
  }
}

/** 该 Cycle 的 Brief 是否已阅读过 */
export async function wasBriefRead(
  accountId: string,
  conversationId: string,
  cycleId: string,
): Promise<boolean> {
  const map = await loadMap();
  return Boolean(map[recordKey(accountId, conversationId, cycleId)]);
}

/** 标记当前 Cycle 的 Brief 已阅读（超出容量时淘汰最早记录） */
export async function markBriefRead(
  accountId: string,
  conversationId: string,
  cycleId: string,
): Promise<void> {
  const map = await loadMap();
  map[recordKey(accountId, conversationId, cycleId)] = new Date().toISOString();
  const entries = Object.entries(map).sort(
    ([, a], [, b]) => new Date(a).getTime() - new Date(b).getTime(),
  );
  const next: BriefReadMap = {};
  for (const [key, value] of entries.slice(-MAX_RECORDS)) {
    next[key] = value;
  }
  await sensitiveStorage.setItemAsync(BRIEF_READ_KEY, JSON.stringify(next));
}

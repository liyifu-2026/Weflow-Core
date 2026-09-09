/**
 * 离线聊天记录缓存模块
 * 在设备安全区域缓存最近的聊天记录，供离线时查看。
 * 限制：最多 20 个会话、总计 100KB、单条 12KB、24 小时过期。
 * 图片和文件消息仅保存占位文本，需联网查看原内容。
 */
import * as Crypto from "expo-crypto";
import { sensitiveStorage } from "@/storage/sensitive-storage";
import type { HandoffDetail, ServerMessage, TranscriptPage } from "./api";

const KEY_PREFIX = "weflow.mobile.transcript-cache.";
const INDEX_PREFIX = "weflow.mobile.transcript-cache-index.";
const MAX_ENTRIES = 20;        // 最多缓存的会话数
const MAX_TOTAL_BYTES = 100_000; // 缓存总大小上限（字节）
const MAX_ENTRY_BYTES = 12_000;  // 单个会话缓存大小上限（字节）
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 缓存过期时间：24 小时

type CacheEntry = {
  accountId: string;
  conversationId: string;
  messages: ServerMessage[];
  nextCursor: null;
  conversationRevision?: number;
  handoff?: HandoffDetail;
  cachedAt: string;
  size: number;
};

/** 加载离线缓存的聊天记录，过期或数据不一致时自动清除并返回 undefined */
export async function loadCachedTranscript(
  accountId: string,
  conversationId: string,
): Promise<TranscriptPage | undefined> {
  const key = await cacheKey(accountId, conversationId);
  const serialized = await sensitiveStorage.getItemAsync(key);
  if (!serialized) return undefined;
  try {
    const entry = JSON.parse(serialized) as CacheEntry;
    if (
      entry.accountId !== accountId ||
      entry.conversationId !== conversationId ||
      Date.now() - new Date(entry.cachedAt).getTime() > MAX_AGE_MS
    ) {
      await sensitiveStorage.deleteItemAsync(key);
      await forgetCacheKey(accountId, key);
      return undefined;
    }
    return {
      messages: entry.messages,
      nextCursor: entry.nextCursor,
      conversationRevision: entry.conversationRevision,
      cachedHandoff: entry.handoff,
    };
  } catch {
    await sensitiveStorage.deleteItemAsync(key);
    await forgetCacheKey(accountId, key);
    return undefined;
  }
}

/** 缓存聊天记录，截取最近 20 条消息并限制文本长度，超限时自动跳过 */
export async function saveCachedTranscript(
  accountId: string,
  conversationId: string,
  page: TranscriptPage,
  handoff?: HandoffDetail,
): Promise<void> {
  const messages = page.messages.slice(-20).map((message) => ({
    ...message,
    text:
      message.contentType === "text"
        ? message.text.slice(0, 2_000)
        : message.contentType === "image"
          ? "图片需联网查看"
          : "文件需联网查看",
  }));
  const key = await cacheKey(accountId, conversationId);
  const entry: CacheEntry = {
    accountId,
    conversationId,
    messages,
    nextCursor: null,
    conversationRevision: page.conversationRevision,
    handoff: handoff
      ? {
          ...handoff,
          briefing:
            handoff.briefing?.sourceConversationRevision ===
            page.conversationRevision
              ? handoff.briefing
              : null,
        }
      : undefined,
    cachedAt: new Date().toISOString(),
    size: 0,
  };
  const serialized = JSON.stringify(entry);
  if (serialized.length > MAX_ENTRY_BYTES) return;
  entry.size = serialized.length;
  try {
    await sensitiveStorage.setItemAsync(key, JSON.stringify(entry));
    await rememberCacheKey(accountId, key);
    await enforceCacheLimits(accountId);
  } catch {
    // Offline cache is opportunistic; it must never block the live transcript.
  }
}

/** 清除指定账号的所有离线缓存 */
export async function clearAccountTranscriptCache(accountId: string): Promise<void> {
  const keys = await loadCacheIndex(accountId);
  await Promise.all(keys.map((key) => sensitiveStorage.deleteItemAsync(key)));
  await sensitiveStorage.deleteItemAsync(await indexKey(accountId));
}

/** 执行缓存容量限制策略：按时间排序保留最新的条目，超出限制时删除最旧的 */
async function enforceCacheLimits(accountId: string): Promise<void> {
  const keys = await loadCacheIndex(accountId);
  const entries = await Promise.all(
    keys.map(async (key) => {
      const value = await sensitiveStorage.getItemAsync(key);
      if (!value) return undefined;
      try {
        return { key, entry: JSON.parse(value) as CacheEntry };
      } catch {
        return undefined;
      }
    }),
  );
  const valid = entries
    .filter((item): item is { key: string; entry: CacheEntry } => Boolean(item))
    .sort((a, b) => b.entry.cachedAt.localeCompare(a.entry.cachedAt));
  let total = 0;
  const keep: string[] = [];
  for (const item of valid) {
    if (keep.length >= MAX_ENTRIES || total + item.entry.size > MAX_TOTAL_BYTES) {
      await sensitiveStorage.deleteItemAsync(item.key);
      continue;
    }
    total += item.entry.size;
    keep.push(item.key);
  }
  await sensitiveStorage.setItemAsync(await indexKey(accountId), JSON.stringify(keep));
}

async function rememberCacheKey(accountId: string, key: string): Promise<void> {
  const keys = await loadCacheIndex(accountId);
  if (!keys.includes(key)) {
    await sensitiveStorage.setItemAsync(await indexKey(accountId), JSON.stringify([...keys, key]));
  }
}

async function forgetCacheKey(accountId: string, key: string): Promise<void> {
  const keys = await loadCacheIndex(accountId);
  await sensitiveStorage.setItemAsync(await indexKey(accountId), JSON.stringify(keys.filter((item) => item !== key)));
}

async function loadCacheIndex(accountId: string): Promise<string[]> {
  const value = await sensitiveStorage.getItemAsync(await indexKey(accountId));
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function cacheKey(accountId: string, conversationId: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${accountId}\0${conversationId}`,
  );
  return `${KEY_PREFIX}${digest}`;
}

async function indexKey(accountId: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    accountId,
  );
  return `${INDEX_PREFIX}${digest}`;
}

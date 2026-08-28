/**
 * 本地草稿存储模块
 * 管理客服回复草稿的安全持久化，按账号隔离存储。
 * 生产实例使用 Expo SecureStore 与 SHA256 摘要；测试使用 draft-store-core 注入内存实现。
 */
import * as Crypto from "expo-crypto";
import { sensitiveStorage } from "@/storage/sensitive-storage";
import {
  createDraftStore,
  type DraftStore,
  type LocalDraft,
} from "./draft-store-core";

export type { DraftSource, DraftStore, LocalDraft } from "./draft-store-core";

/** 生产环境默认实例：真实 SecureStore + SHA256。 */
export const draftStore: DraftStore = createDraftStore({
  storage: sensitiveStorage,
  digest: (value) =>
    Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value),
});

export function loadDraft(
  accountId: string,
  conversationId: string,
  handoffId: string,
): Promise<LocalDraft | undefined> {
  return draftStore.loadDraft(accountId, conversationId, handoffId);
}

export function loadLatestConversationDraft(
  accountId: string,
  conversationId: string,
): Promise<LocalDraft | undefined> {
  return draftStore.loadLatestConversationDraft(accountId, conversationId);
}

export function saveDraft(draft: LocalDraft): Promise<void> {
  return draftStore.saveDraft(draft);
}

export function deleteDraft(
  accountId: string,
  conversationId: string,
  handoffId: string,
): Promise<void> {
  return draftStore.deleteDraft(accountId, conversationId, handoffId);
}

export function clearAccountDrafts(accountId: string): Promise<void> {
  return draftStore.clearAccountDrafts(accountId);
}

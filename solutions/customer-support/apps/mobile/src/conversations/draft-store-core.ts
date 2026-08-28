/**
 * 本地草稿存储核心模块
 * 草稿按账号隔离存储，键名使用摘要避免泄露业务标识。
 * 存储与摘要算法由调用方注入，生产环境使用 SecureStore + SHA256，
 * 测试环境使用内存存储与确定性摘要。
 */

/** 草稿来源：手动输入或智能建议 */
export type DraftSource = "manual" | "suggested";

/** 本地草稿数据结构 */
export type LocalDraft = {
  accountId: string;
  conversationId: string;
  handoffId: string;
  baseConversationRevision: number | null;
  reviewedAtRevision: number | null;
  content: string;
  source: DraftSource;
  origin?: "manual" | "ai_suggestion";
  edited?: boolean;
  suggestionId?: string;
  sourceRevision?: number;
  evidenceIds?: string[];
  evidenceId?: string;
  /** Local-only record used to resolve a lost message response before retry. */
  pendingMessage?: {
    clientRequestId: string;
    text: string;
    occurredAt: string;
    expectedConversationRevision?: number;
  };
  status: "saved_local" | "locked_reauth" | "archived_transfer" | "stale_revision";
  updatedAt: string;
};

export type DraftStore = {
  loadDraft(
    accountId: string,
    conversationId: string,
    handoffId: string,
  ): Promise<LocalDraft | undefined>;
  loadLatestConversationDraft(
    accountId: string,
    conversationId: string,
  ): Promise<LocalDraft | undefined>;
  saveDraft(draft: LocalDraft): Promise<void>;
  deleteDraft(
    accountId: string,
    conversationId: string,
    handoffId: string,
  ): Promise<void>;
  clearAccountDrafts(accountId: string): Promise<void>;
};

export type DraftStoreDependencies = {
  storage: {
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
    deleteItemAsync(key: string): Promise<void>;
  };
  digest: (value: string) => Promise<string>;
};

const KEY_PREFIX = "weflow.mobile.draft.";
const INDEX_PREFIX = "weflow.mobile.draft-index.";

/** 创建草稿存储实例；测试可注入内存存储与确定性摘要。 */
export function createDraftStore(deps: DraftStoreDependencies): DraftStore {
  return {
    async loadDraft(accountId, conversationId, handoffId) {
      const key = await draftKey(deps, accountId, conversationId, handoffId);
      const value = await deps.storage.getItemAsync(key);
      if (!value) return undefined;
      try {
        return JSON.parse(value) as LocalDraft;
      } catch {
        await deps.storage.deleteItemAsync(key);
        return undefined;
      }
    },
    async loadLatestConversationDraft(accountId, conversationId) {
      const index = await loadDraftIndex(deps, accountId);
      const drafts = await Promise.all(
        index.map(async (key) => {
          const value = await deps.storage.getItemAsync(key);
          if (!value) return undefined;
          try {
            return JSON.parse(value) as LocalDraft;
          } catch {
            await deps.storage.deleteItemAsync(key);
            return undefined;
          }
        }),
      );
      return drafts
        .filter(
          (draft): draft is LocalDraft =>
            draft?.accountId === accountId &&
            draft.conversationId === conversationId,
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    },
    async saveDraft(draft) {
      const key = await draftKey(
        deps,
        draft.accountId,
        draft.conversationId,
        draft.handoffId,
      );
      await deps.storage.setItemAsync(key, JSON.stringify(draft));
      await rememberDraftKey(deps, draft.accountId, key);
    },
    async deleteDraft(accountId, conversationId, handoffId) {
      const key = await draftKey(deps, accountId, conversationId, handoffId);
      await deps.storage.deleteItemAsync(key);
      await forgetDraftKey(deps, accountId, key);
    },
    async clearAccountDrafts(accountId) {
      const index = await loadDraftIndex(deps, accountId);
      await Promise.all(
        index.map((key) => deps.storage.deleteItemAsync(key)),
      );
      await deps.storage.deleteItemAsync(await indexKey(deps, accountId));
    },
  };
}

async function rememberDraftKey(
  deps: DraftStoreDependencies,
  accountId: string,
  key: string,
): Promise<void> {
  const index = await loadDraftIndex(deps, accountId);
  if (!index.includes(key)) {
    await deps.storage.setItemAsync(
      await indexKey(deps, accountId),
      JSON.stringify([...index, key]),
    );
  }
}

async function forgetDraftKey(
  deps: DraftStoreDependencies,
  accountId: string,
  key: string,
): Promise<void> {
  const index = await loadDraftIndex(deps, accountId);
  await deps.storage.setItemAsync(
    await indexKey(deps, accountId),
    JSON.stringify(index.filter((item) => item !== key)),
  );
}

async function loadDraftIndex(
  deps: DraftStoreDependencies,
  accountId: string,
): Promise<string[]> {
  const value = await deps.storage.getItemAsync(await indexKey(deps, accountId));
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** 生成草稿存储键：使用摘要确保键名不泄露业务标识 */
async function draftKey(
  deps: DraftStoreDependencies,
  accountId: string,
  conversationId: string,
  handoffId: string,
): Promise<string> {
  const digest = await deps.digest(
    `${accountId}\0${conversationId}\0${handoffId}`,
  );
  return `${KEY_PREFIX}${digest}`;
}

async function indexKey(
  deps: DraftStoreDependencies,
  accountId: string,
): Promise<string> {
  const digest = await deps.digest(accountId);
  return `${INDEX_PREFIX}${digest}`;
}

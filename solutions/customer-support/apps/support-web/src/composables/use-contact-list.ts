/**
 * 联系人列表（Contact List）。
 *
 * GET /api/v1/contacts 的游标分页 + 去重 + 搜索，工作台联系人搜索与
 * 管理页共用的唯一实现（此前三处各自实现且签名分化）。
 * 搜索词由调用方决定（工作台是防抖后的实时词，管理页是回车确认词）。
 */
import { ref, type Ref } from "vue";
import { api } from "../api";

export type ContactSummary = {
  contactId: string;
  conversationId: string;
  channelDisplayName: string | null;
  channelNickname: string | null;
  channelRemark: string | null;
  sharedAlias: string | null;
  avatarUrl: string | null;
  latestMessageAt: string | null;
  latestMessageText: string;
  /** 自动回复开关：false = 仅人工 */
  agentEnabled: boolean;
  /** 黑名单：true = 不建 Turn / 不进会话列表 / 不推通知 */
  blocked: boolean;
};

/** 服务端过滤条件（不传 = 不过滤） */
export type ContactListFilter = {
  agentEnabled?: boolean;
  blocked?: boolean;
};

export type UseContactList = ReturnType<typeof useContactList>;

export function useContactList(options: {
  /** 返回当前搜索词；空词 = 不带 q 参数 */
  getQuery: () => string;
  /** 返回当前过滤条件；缺省不过滤 */
  getFilter?: () => ContactListFilter;
  pageSize?: number;
}) {
  const { getQuery, getFilter, pageSize = 50 } = options;

  const contacts = ref<ContactSummary[]>([]);
  const nextCursor = ref<string | null>(null);
  const loading = ref(false);
  const loadingMore = ref(false);
  const error = ref("");

  function clear(): void {
    contacts.value = [];
    nextCursor.value = null;
    error.value = "";
  }

  async function load(append = false): Promise<void> {
    if (append ? loadingMore.value : loading.value) return;
    if (append) loadingMore.value = true;
    else loading.value = true;
    error.value = "";
    try {
      const cursor = append ? nextCursor.value : null;
      const query = new URLSearchParams();
      query.set("limit", String(pageSize));
      const q = getQuery().trim();
      if (q) query.set("q", q);
      const filter = getFilter?.() ?? {};
      if (filter.agentEnabled !== undefined)
        query.set("agentEnabled", String(filter.agentEnabled));
      if (filter.blocked !== undefined) query.set("blocked", String(filter.blocked));
      if (cursor) query.set("before", cursor);
      const result = await api<{
        contacts: ContactSummary[];
        nextCursor: string | null;
      }>(`/api/v1/contacts?${query.toString()}`);
      const incoming = result.contacts ?? [];
      if (append) {
        const seen = new Set(contacts.value.map((c) => c.contactId));
        contacts.value = [
          ...contacts.value,
          ...incoming.filter((c) => !seen.has(c.contactId)),
        ];
      } else {
        contacts.value = incoming;
      }
      nextCursor.value = result.nextCursor ?? null;
    } catch (reason) {
      error.value =
        reason instanceof Error ? reason.message : "联系人加载失败";
    } finally {
      if (append) loadingMore.value = false;
      else loading.value = false;
    }
  }

  return {
    contacts: contacts as Ref<ContactSummary[]>,
    nextCursor: nextCursor as Ref<string | null>,
    loading: loading as Ref<boolean>,
    loadingMore: loadingMore as Ref<boolean>,
    error: error as Ref<string>,
    clear,
    load,
  };
}

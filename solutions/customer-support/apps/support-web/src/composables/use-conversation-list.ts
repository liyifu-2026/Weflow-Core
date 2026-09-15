/**
 * 会话列表控制器（Conversation List）。
 *
 * 三区队列（等待处理 / 我处理的 / 其他对话）+ 单列合并视图 + 游标续页 +
 * 搜索分支 + Console 能力门（conversationPermissions）。排序由 Core scope
 * 合同保证；工作区视图返回全部未拉黑客户的会话（黑名单制）。
 */
import { computed, ref, type Ref } from "vue";
import { api } from "../api";
import {
  priority,
  type Conversation,
  type SectionScope,
} from "../components/conversations/types";

const EMPTY_CURSORS: Record<SectionScope, string | null> = {
  attention: null,
  mine: null,
  others: null,
};

export type UseConversationList = ReturnType<typeof useConversationList>;

export function useConversationList(options: {
  /** 搜索词（来自工作区 store，防抖由视图驱动） */
  search: Ref<string>;
  /** 当前选中会话 id：loadList 的「继续旧活优先」只在未选中时自动选 */
  getSelectedId: () => string;
  /** 自动选中（route id 优先，其次「我处理的」第一条） */
  onAutoSelect: (conversationId: string) => Promise<void> | void;
  /** 路由上的会话 id（深链接恢复） */
  getRouteId: () => string;
}) {
  const { search, onAutoSelect, getRouteId } = options;

  // Console 能力门：conversationPermissions 未开启 → 旧双 Tab + 本地推导；
  // 开启 → 三区列表 + 服务端 permissions 驱动（字段缺失即只读，fail-safe）。
  const capabilities = ref<Record<string, boolean> | null>(null);
  const conversationPermissionsEnabled = computed(
    () => capabilities.value?.conversationPermissions === true,
  );

  const loadingList = ref(true);
  const listError = ref("");
  // 三区（capability 开启且非搜索态时使用；排序由 Core scope 合同保证）
  const sectionAttention = ref<Conversation[]>([]);
  const sectionMine = ref<Conversation[]>([]);
  const sectionOthers = ref<Conversation[]>([]);
  const listNextCursors = ref<Record<SectionScope, string | null>>({ ...EMPTY_CURSORS });
  const listLoadingMore = ref<Record<SectionScope, boolean>>({
    attention: false,
    mine: false,
    others: false,
  });
  const conversations = ref<Conversation[]>([]);

  // 左侧列表：微信式单列（头像+昵称+摘要+未读），按风险/交接/未读排序。
  const flatConversations = computed<Conversation[]>(() => {
    const rows = conversationPermissionsEnabled.value
      ? [...sectionAttention.value, ...sectionMine.value, ...sectionOthers.value]
      : conversations.value;
    const seen = new Set<string>();
    const merged: Conversation[] = [];
    for (const item of rows) {
      if (seen.has(item.conversationId)) continue;
      seen.add(item.conversationId);
      merged.push(item);
    }
    return merged.sort((a, b) => priority(b) - priority(a));
  });

  // 三区会话（问题 4：等待处理 / 我处理的 / 其他对话，颜色区分）。
  // 与 mobile 端一致：attention=等待处理（红）、mine=我处理的（蓝）、others=其他（灰）。
  const queueSections = computed<
    Array<{ key: SectionScope; title: string; tone: string; items: Conversation[] }>
  >(() => {
    const seen = new Set<string>();
    const pick = (rows: Conversation[]) => {
      const out: Conversation[] = [];
      for (const item of rows) {
        if (seen.has(item.conversationId)) continue;
        seen.add(item.conversationId);
        out.push(item);
      }
      return out;
    };
    return [
      { key: "attention", title: "等待处理", tone: "attention", items: pick(sectionAttention.value) },
      { key: "mine", title: "我处理的", tone: "mine", items: pick(sectionMine.value) },
      { key: "others", title: "其他对话", tone: "others", items: pick(sectionOthers.value) },
    ];
  });

  const hasMoreConversations = computed(() =>
    Object.values(listNextCursors.value).some(Boolean),
  );
  const loadingMoreConversations = computed(() =>
    Object.values(listLoadingMore.value).some(Boolean),
  );

  /** 在全部已知行里找会话（选中行、联系人卡片等派生数据的数据源） */
  function findConversation(conversationId: string): Conversation | undefined {
    return [
      ...sectionAttention.value,
      ...sectionMine.value,
      ...sectionOthers.value,
      ...conversations.value,
    ].find((item) => item.conversationId === conversationId);
  }

  async function loadList(selectFirst = false): Promise<void> {
    listError.value = "";
    try {
      if (search.value.trim()) {
        conversations.value = (
          await api<{ conversations: Conversation[] }>(
            `/api/v1/conversations/search?q=${encodeURIComponent(search.value.trim())}&limit=50`,
          )
        ).conversations;
      } else if (conversationPermissionsEnabled.value) {
        // 三区由 Core scope 合同计算并排序（attention 按风险+handoff 权重+未读）。
        // 黑名单制（0078）：列表不再按 agentEnabled 过滤——「仅人工」的会话
        // 也要可见；已拉黑联系人的会话由 Core 默认排除。
        // 联系人视图不调用本接口（用 /api/v1/contacts）。
        const [attention, mine, others] = await Promise.all([
          api<{ conversations: Conversation[]; nextCursor?: string | null }>(
            "/api/v1/conversations?limit=100&scope=attention",
          ),
          api<{ conversations: Conversation[]; nextCursor?: string | null }>(
            "/api/v1/conversations?limit=100&scope=mine",
          ),
          api<{ conversations: Conversation[]; nextCursor?: string | null }>(
            "/api/v1/conversations?limit=100&scope=others",
          ),
        ]);
        sectionAttention.value = attention.conversations ?? [];
        sectionMine.value = mine.conversations ?? [];
        sectionOthers.value = others.conversations ?? [];
        listNextCursors.value = {
          attention: attention.nextCursor ?? null,
          mine: mine.nextCursor ?? null,
          others: others.nextCursor ?? null,
        };
        conversations.value = [];
      } else {
        conversations.value = (
          await api<{ conversations: Conversation[] }>(
            "/api/v1/conversations?limit=100",
          )
        ).conversations;
      }
      const routeId = getRouteId();
      // 继续旧活优先：默认落「我处理的」第一条，其次等待处理，最后其他
      const firstInSections =
        sectionMine.value[0] ?? sectionAttention.value[0] ?? sectionOthers.value[0];
      const first = search.value.trim() ? conversations.value[0] : firstInSections;
      if (
        (selectFirst || !options.getSelectedId()) &&
        (routeId || first?.conversationId)
      ) {
        await onAutoSelect(routeId || first!.conversationId);
      }
    } catch (reason) {
      listError.value =
        reason instanceof Error ? reason.message : "会话队列加载失败";
    } finally {
      loadingList.value = false;
    }
  }

  /** Console 能力门拉取；能力到达后立即切换到三区形态（再刷一次列表） */
  async function loadCapabilities(): Promise<void> {
    try {
      const result = await api<{ capabilities: Record<string, boolean> }>(
        "/api/v1/console/capabilities",
      );
      capabilities.value = result.capabilities;
      void loadList();
    } catch {
      capabilities.value = {};
    }
  }

  /** 分区「加载更多」：游标续页，追加去重 */
  async function loadMoreSection(scope: SectionScope): Promise<void> {
    const cursor = listNextCursors.value[scope];
    if (!cursor || listLoadingMore.value[scope]) return;
    listLoadingMore.value[scope] = true;
    try {
      const result = await api<{
        conversations: Conversation[];
        nextCursor?: string | null;
      }>(
        `/api/v1/conversations?limit=100&scope=${scope}&before=${encodeURIComponent(cursor)}`,
      );
      const target =
        scope === "attention"
          ? sectionAttention
          : scope === "mine"
            ? sectionMine
            : sectionOthers;
      const seen = new Set(target.value.map((item) => item.conversationId));
      target.value = [
        ...target.value,
        ...(result.conversations ?? []).filter(
          (item) => !seen.has(item.conversationId),
        ),
      ];
      listNextCursors.value[scope] = result.nextCursor ?? null;
    } catch {
      // 静默；下一轮重试
    } finally {
      listLoadingMore.value[scope] = false;
    }
  }

  /** 单列列表底部的「加载更多」：对所有仍有游标的分区并发续页。 */
  async function loadOlderConversations(): Promise<void> {
    const scopes = Object.keys(listNextCursors.value) as SectionScope[];
    await Promise.all(
      scopes
        .filter((scope) => listNextCursors.value[scope])
        .map((scope) => loadMoreSection(scope)),
    );
  }

  return {
    capabilities,
    conversationPermissionsEnabled,
    loadingList,
    listError,
    sectionAttention,
    sectionMine,
    sectionOthers,
    listNextCursors,
    conversations,
    flatConversations,
    queueSections,
    hasMoreConversations,
    loadingMoreConversations,
    findConversation,
    loadList,
    loadCapabilities,
    loadMoreSection,
    loadOlderConversations,
  };
}

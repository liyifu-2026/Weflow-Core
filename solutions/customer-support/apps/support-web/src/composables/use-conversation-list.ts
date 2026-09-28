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
  // G3：记录被用户「加载更多」续过页的分区。15s 对账/5s 兜底/SSE 触发的
  // loadList 若把三区无条件替换回第一页，用户翻出来的旧会话会整批消失。
  const pagedScopes = ref<Record<SectionScope, boolean>>({
    attention: false,
    mine: false,
    others: false,
  });
  // G3 拼接行淘汰语义（第二轮修订）：第一轮用「连续 2 次刷新未在服务端
  // 数据里出现即淘汰」的计数器，但第 101+ 行永远不在服务端第一页里，
  // 连续 2 次刷新（10-30s）后必被误删——翻页结果实际留不住。
  // 现改为：拼接行一直保留，只在拿到「明确消失证据」时才丢弃——
  // ① 被吸收：它重新出现在了服务端 fresh 数据里（去重合并自然吸收，
  //    或 loadMoreSection 续页命中后就地换成服务端版本）；
  // ② 服务端翻到底：用户主动 loadMoreSection 且续页无下一页游标，
  //    说明服务端已对该区尾部完整对账，仍未出现的拼接行确认消失；
  // ③ 区已缩水：loadList 返回的 fresh 没有下一页游标，说明该区总条数
  //    ≤ 第一页容量、已不存在第 101+ 行，无法匹配的拼接行全部清掉。
  // carriedIds 记录各区「当前未被服务端数据确认」的行 id，仅供内部
  // 对账使用（非响应式；列表展示由三区数组驱动）。
  const carriedIds: Record<SectionScope, Set<string>> = {
    attention: new Set(),
    mine: new Set(),
    others: new Set(),
  };
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
        // G3：刷新保留续页状态。未翻页的区行为完全不变（新第一页 + 新游标）；
        // 已翻页的区：新第一页照常替换头部，游标尽量保留原值（用户翻页边界
        // 不因刷新而丢），并把「新列表里没有、但旧列表里有的行」拼到尾部
        // （按 conversationId 去重、新列表顺序优先）。拼接行不再按「连续
        // 未命中次数」淘汰（第 101+ 行永远不在 fresh 第一页里，计数器必然
        // 误删）；只在服务端给出明确消失证据时丢弃，判据见 carriedIds 注释。
        const previousCursors = { ...listNextCursors.value };
        const withCarriedTail = (
          scope: SectionScope,
          fresh: Conversation[],
          freshCursor: string | null | undefined,
        ): Conversation[] => {
          const carried = carriedIds[scope];
          if (!pagedScopes.value[scope]) {
            // 未翻页的区：整区以服务端为准，无拼接行需要对账。
            carried.clear();
            return fresh;
          }
          const freshIds = new Set(fresh.map((item) => item.conversationId));
          // 判据①：曾被拼接的行重新被服务端确认 → 从拼接集合移除（吸收）。
          for (const id of carried) {
            if (freshIds.has(id)) carried.delete(id);
          }
          const previous =
            scope === "attention"
              ? sectionAttention.value
              : scope === "mine"
                ? sectionMine.value
                : sectionOthers.value;
          // 拼接行 = 旧列表里 fresh 第一页没有的行（无论它此前是否被服务端
          // 确认过——现在它不在第一页，就处于「未确认」状态，继续保留）。
          const tail = previous.filter(
            (row) => !freshIds.has(row.conversationId),
          );
          if (!freshCursor) {
            // 判据③：fresh 没有下一页游标 → 该区总条数 ≤ 第一页容量，
            // 不在第一页里的旧行必然已从该区消失（删除/移出/排队结束），
            // 全部丢弃。游标归零见下方 listNextCursors 赋值（这里先改会被
            // 整体赋值覆盖，故统一在赋值处按 freshCursor 收口）。
            carried.clear();
            return [...fresh];
          }
          carried.clear();
          for (const row of tail) carried.add(row.conversationId);
          return [...fresh, ...tail];
        };
        sectionAttention.value = withCarriedTail(
          "attention",
          attention.conversations ?? [],
          attention.nextCursor ?? null,
        );
        sectionMine.value = withCarriedTail("mine", mine.conversations ?? [], mine.nextCursor ?? null);
        sectionOthers.value = withCarriedTail(
          "others",
          others.conversations ?? [],
          others.nextCursor ?? null,
        );
        // 游标规则：未翻页的区 = 服务端新游标（行为不变）。已翻页的区：
        // fresh 仍有下一页 → 优先保留用户翻到的旧边界游标（旧边界失效时
        // 回退 fresh 游标兜底恢复续页）；fresh 已无下一页（判据③触发）→
        // 归零，避免「加载更多」拿着已失效的旧游标空转。
        listNextCursors.value = {
          attention: pagedScopes.value.attention
            ? attention.nextCursor
              ? (previousCursors.attention ?? attention.nextCursor ?? null)
              : null
            : (attention.nextCursor ?? null),
          mine: pagedScopes.value.mine
            ? mine.nextCursor
              ? (previousCursors.mine ?? mine.nextCursor ?? null)
              : null
            : (mine.nextCursor ?? null),
          others: pagedScopes.value.others
            ? others.nextCursor
              ? (previousCursors.others ?? others.nextCursor ?? null)
              : null
            : (others.nextCursor ?? null),
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
      const continuation = result.conversations ?? [];
      const existingIds = new Set(target.value.map((item) => item.conversationId));
      const byId = new Map(
        continuation.map((item) => [item.conversationId, item]),
      );
      // G3 判据①：续页结果里出现的行 = 服务端最新确认 → 就地替换旧行
      // （含拼接行），保证服务端有发言权的位置一律以服务端版本为准；
      // 其余续页行（本地没有的）照旧追加去重。
      target.value = [
        ...target.value.map((row) => byId.get(row.conversationId) ?? row),
        ...continuation.filter((item) => !existingIds.has(item.conversationId)),
      ];
      // 被续页确认的行不再是「未确认拼接行」。
      for (const item of continuation) carriedIds[scope].delete(item.conversationId);
      listNextCursors.value[scope] = result.nextCursor ?? null;
      // G3 判据②：用户主动续页且服务端已无下一页 → 该区尾部已被服务端
      // 完整对账，仍未出现的拼接行确认已消失，全部丢弃。
      if (!result.nextCursor) carriedIds[scope].clear();
      // G3：该区已被用户翻页，后续刷新须保留续页结果（见 loadList）
      pagedScopes.value[scope] = true;
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

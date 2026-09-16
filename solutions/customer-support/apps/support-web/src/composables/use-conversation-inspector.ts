/**
 * 会话 Inspector 控制器（右侧上下文检查器）。
 *
 * 拥有 Inspector 的展开/收起/深度视图状态、联系人资料（含 note/tags 编辑）、
 * 客服列表（转交与 @提及的数据源）、以及「历史对话」只读子分页。
 * profile 的拉取由 selection 在 6 路并发装载中调用（fetchProfile），
 * 代际检查通过后经 applyProfile 落位——保证快速切换会话时旧资料不写入。
 */
import { computed, ref, type Ref } from "vue";
import { api } from "../api";
import type { Message } from "../components/conversations/types";


export type InspectorView = "context" | "brief" | "evidence" | "customer" | "history";

type HistoryConversation = {
  conversationId: string;
  latestMessageAt: string | null;
  latestMessageText?: string | null;
  handoffStatus?: string | null;
};

export type UseConversationInspector = ReturnType<typeof useConversationInspector>;

export function useConversationInspector(options: {
  /** 当前选中会话 id（历史对话、资料保存都以它为准） */
  getSelectedId: () => string;
  /** 当前选中行的联系人 id（历史对话按联系人查） */
  getSelectedContactId: () => string | undefined;
}) {
  const inspectorOpen = ref(false);
  // 收起偏好记忆（UX-DECISIONS §1）：手动收起后不再随选中自动展开。
  // 桌面壳首次进入会由 main.ts 的 applyDesktopShellDefaults() 预置 "collapsed"
  // ——桌面窗口宽度有限，聊天区优先；用户手动展开一次即写回 "open"。
  const inspectorCollapsed = ref(
    localStorage.getItem("wf-inspector") === "collapsed",
  );
  const inspectorView = ref<InspectorView>("context");
  const profile = ref<any>(null);
  const note = ref("");
  const tags = ref("");
  const assignees = ref<any[]>([]);

  const company = computed(
    () =>
      String(
        profile.value?.companyName ||
          profile.value?.company ||
          profile.value?.organization ||
          "",
      ) || "",
  );

  const inspectorTitle = computed(() => {
    switch (inspectorView.value) {
      case "context":
        return "当前上下文";
      case "brief":
        return "交接说明";
      case "evidence":
        return "回答依据";
      case "customer":
        return "客户资料";
      case "history":
        return "历史对话";
    }
  });
  const inspectorDepth = computed(() => {
    if (inspectorView.value === "context") return 0;
    if (inspectorView.value === "history" && historySelectedId.value) return 2;
    return 1;
  });

  function setInspectorCollapsed(collapsed: boolean): void {
    inspectorCollapsed.value = collapsed;
    localStorage.setItem("wf-inspector", collapsed ? "collapsed" : "open");
  }

  // Inspector：统一右侧上下文检查器。顶层为「当前上下文」，
  // 点击条目进入深度视图（交接说明/回答依据/客户资料），返回键回顶层。
  function openInspector(view: InspectorView): void {
    inspectorView.value = view;
    setInspectorCollapsed(false);
    inspectorOpen.value = true;
    if (view === "history") void loadHistory();
  }

  function closeInspector(): void {
    setInspectorCollapsed(true);
    inspectorOpen.value = false;
  }

  /** 选中会话开始：复位到顶层视图；用户手动收起后记忆偏好，不再自动弹出 */
  function prepareForSelection(): void {
    inspectorView.value = "context";
    if (!inspectorCollapsed.value) inspectorOpen.value = true;
  }

  function inspectorBack(): void {
    if (inspectorView.value === "history" && historySelectedId.value) {
      historySelectedId.value = "";
      historyMessages.value = [];
      return;
    }
    inspectorView.value = "context";
  }

  /** 仅拉取资料（selection 的并发装载用）；失败即详情装载失败 */
  async function fetchProfile(conversationId: string): Promise<{ profile: any }> {
    return api<any>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/contact-profile`,
    );
  }

  /** 代际检查通过后落位：资料 + 编辑态 note/tags 初始化 */
  function applyProfile(nextProfile: any): void {
    profile.value = nextProfile;
    note.value = profile.value.note ?? "";
    tags.value = (profile.value.tags ?? []).join("、");
  }

  async function saveProfile(): Promise<void> {
    const conversationId = options.getSelectedId();
    if (!conversationId || !profile.value) return;
    const result = await api<any>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/contact-profile`,
      {
        method: "PATCH",
        body: JSON.stringify({
          note: note.value || null,
          tags: tags.value
            .split(/[、,，]/)
            .map((value) => value.trim())
            .filter(Boolean),
          agentEnabled: profile.value.agentEnabled,
        }),
      },
    );
    profile.value = result.profile;
  }

  async function loadAssignees(): Promise<void> {
    const result = await api<{
      users: Array<{ userId: string; username: string; displayName?: string | null }>;
    }>("/api/v1/handoff-assignees");
    assignees.value = result.users;
  }

  // 联系人的历史会话（只读，Inspector 内查看；游标分页）
  const historyConversations = ref<HistoryConversation[]>([]);
  const historyLoading = ref(false);
  const historyNextCursor = ref<string | null>(null);
  const historySelectedId = ref("");
  const historyMessages = ref<Message[]>([]);
  const historyMessagesLoading = ref(false);
  const historyMessagesNextCursor = ref<string | null>(null);

  // 历史对话：Inspector 内只读查看该联系人的其他会话（不离开当前 Workspace）
  // 使用正式 Contact History 合同（游标分页，只读；不可接管或回复）
  async function loadHistory(append = false): Promise<void> {
    if (!options.getSelectedId() || historyLoading.value) return;
    const contactId = options.getSelectedContactId();
    if (!contactId) return;
    historyLoading.value = true;
    try {
      if (!append) {
        historyConversations.value = [];
        historyNextCursor.value = null;
      }
      const cursor = append ? historyNextCursor.value : null;
      const result = await api<{
        conversations: HistoryConversation[];
        nextCursor: string | null;
      }>(
        `/api/v1/contacts/${encodeURIComponent(contactId)}/conversations?limit=20${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
      );
      historyConversations.value = [
        ...historyConversations.value,
        ...(result.conversations ?? []),
      ];
      historyNextCursor.value = result.nextCursor ?? null;
    } catch {
      historyConversations.value = [];
    } finally {
      historyLoading.value = false;
    }
  }

  async function openHistoryConversation(id: string): Promise<void> {
    historySelectedId.value = id;
    historyMessages.value = [];
    historyMessagesNextCursor.value = null;
    await loadMoreHistoryMessages(id);
  }

  async function loadMoreHistoryMessages(id = historySelectedId.value): Promise<void> {
    if (!id || historyMessagesLoading.value) return;
    historyMessagesLoading.value = true;
    try {
      const cursor = historyMessagesNextCursor.value;
      const result = await api<{
        messages: Message[];
        nextCursor?: string | null;
      }>(
        `/api/v1/conversations/${encodeURIComponent(id)}/messages?limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
      );
      historyMessages.value = [
        ...historyMessages.value,
        ...(result.messages ?? []),
      ];
      historyMessagesNextCursor.value = result.nextCursor ?? null;
    } catch {
      // 静默；下一轮重试
    } finally {
      historyMessagesLoading.value = false;
    }
  }

  return {
    inspectorOpen: inspectorOpen as Ref<boolean>,
    inspectorCollapsed: inspectorCollapsed as Ref<boolean>,
    inspectorView: inspectorView as Ref<InspectorView>,
    inspectorTitle,
    inspectorDepth,
    profile: profile as Ref<any>,
    note: note as Ref<string>,
    tags: tags as Ref<string>,
    assignees,
    company,
    historyConversations,
    historyLoading,
    historyNextCursor,
    historySelectedId,
    historyMessages,
    historyMessagesLoading,
    historyMessagesNextCursor,
    setInspectorCollapsed,
    openInspector,
    closeInspector,
    prepareForSelection,
    inspectorBack,
    fetchProfile,
    applyProfile,
    saveProfile,
    loadAssignees,
    loadHistory,
    openHistoryConversation,
    loadMoreHistoryMessages,
  };
}

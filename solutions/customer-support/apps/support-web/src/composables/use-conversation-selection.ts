/**
 * 会话选择与详情控制器（Conversation Selection）。
 *
 * 选中会话 → 6 路并发详情装载（转录/handoff/evidence/session/wakes/
 * turnHealth，另经 deps 并行装载联系人资料）→ 代际检查 → 就地状态替换。
 * 快速切换会话时旧会话的迟到响应必须被丢弃（selectionGeneration）。
 * 另拥有：增量转录刷新（append + 就地 patch）、静默上下文刷新、
 * 更早消息分页（滚动锚定）、决策轨迹装载。
 */
import { computed, nextTick, ref } from "vue";
import type { Ref } from "vue";
import type { RouteLocationNormalizedLoaded, Router } from "vue-router";
import { api } from "../api";
import { mergeTranscriptMessages } from "../components/conversations/transcript-merge";
import { firstVisibleMessageId, restoreAnchor, type UseTranscriptScroll } from "./use-transcript-scroll";
import { normalizeHandoffStatus } from "../lib/handoff-vocab";
import type {
  Conversation,
  Evidence,
  Message,
} from "../components/conversations/types";

export type HandoffDetail = {
  cycles?: Record<string, any>[];
  state?: Record<string, any>;
  briefing?: {
    problemSummary?: string;
    confirmedFacts?: Array<{ label: string; value: string }>;
    unresolvedItems?: string[];
  } | null;
  [key: string]: any;
} | null;

export type SessionEpisode = {
  state: string;
  roundsUsed: number;
  roundBudget: number;
  startedAt?: string;
  closedAt?: string | null;
  closureSummary?: string | null;
};

/** 轮次体检（A3）：四类结果计数 + 孤儿入站消息 + 每轮概要 */
export type TurnHealth = {
  counts: { replied: number; no_reply: number; failed: number; in_flight: number };
  outcomes: Array<{
    turnId: string;
    status: string;
    errorCode: string | null;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    triggerMessageId: string | null;
    replyBatchId: string | null;
    outcome: string;
  }>;
  orphans: Array<{ messageId: string; contentType: string; text: string; occurredAt: string }>;
  orphanCount: number;
};

export type SessionTrace = {
  turn: { turnId: string; status: string; model?: string; traceId?: string; startedAt?: string; completedAt?: string } | null;
  events: { eventType: string; reasonCode?: string | null; payload?: Record<string, any>; createdAt: string }[];
  toolExecutions?: {
    executionId: string;
    toolName: string;
    status: string;
    errorCode?: string | null;
    arguments?: Record<string, string> | null;
    result?: Record<string, unknown> | null;
    createdAt: string;
    completedAt?: string | null;
  }[];
};

export type UseConversationSelection = ReturnType<typeof useConversationSelection>;

export function useConversationSelection(options: {
  route: RouteLocationNormalizedLoaded;
  router: Router;
  scroll: UseTranscriptScroll;
  /** 在全部已知列表行里找会话（选中行派生数据的数据源） */
  findSelected: (conversationId: string) => Conversation | undefined;
  /** 并行装载联系人资料（inspector 持有 profile）；失败 = 详情装载失败 */
  loadProfile: (conversationId: string) => Promise<{ profile: any }>;
  /** 代际检查通过后应用资料（inspector 初始化 note/tags） */
  applyProfile: (profile: any) => void;
  /** 选中开始（路由同步前）：Inspector 展开与转交弹窗复位由视图接线 */
  onSelectionStart?: () => void;
  /** 会话详情装载完成（handoff 就位）后回调（→ 实时 live-turn 轮询） */
  onConversationSelected?: (conversationId: string) => void;
  /** select 收尾（pending 补刷之后）回调（→ unknown 消息自动查证） */
  onSettled?: () => void;
}) {
  const { route, scroll } = options;

  // Race-condition 保护：快速切换会话时，旧会话的迟到响应必须被丢弃。
  let selectionGeneration = 0;

  const selectedId = ref("");
  const loadingConversation = ref(false);
  const detailError = ref("");
  const messages = ref<Message[]>([]);
  const conversationRevision = ref(0);
  const nextCursor = ref<string | null>(null);
  const loadingOlder = ref(false);
  const handoff = ref<HandoffDetail | null>(null);
  const agentSession = ref<SessionEpisode | null>(null);
  const sessionWakes = ref<
    { wakeId: number; turnId: string; kind: string; status: string; wakeAt: string; nudgeText?: string | null }[]
  >([]);
  const turnHealth = ref<TurnHealth | null>(null);
  const evidence = ref<Evidence[]>([]);
  const sessionTraceLoading = ref(false);
  const sessionTraceTurnId = ref<string | null>(null);
  const sessionTrace = ref<SessionTrace | null>(null);
  const sessionTraceOpen = ref(false);

  const selected = computed<Conversation | undefined>(() => options.findSelected?.(selectedId.value));

  // 决策轨迹入口：取最近一次已回复的 turn（回复消息 id 里带 turnId）
  const lastReplyTurnId = computed(() => {
    const last = [...messages.value]
      .reverse()
      .find((m) => m.actorType === "agent" && m.messageId.startsWith("agent-message:turn:"));
    if (!last) return null;
    const match = last.messageId.match(/^agent-message:(turn:[^:]+.*?):\d+$/);
    return match?.[1] ?? null;
  });

  function applyHandoff(next: HandoffDetail | null): void {
    handoff.value = next;
    if (handoff.value?.state?.status) {
      handoff.value.state.status =
        normalizeHandoffStatus(handoff.value.state.status) ??
        handoff.value.state.status;
    }
  }

  function isSelected(conversationId: string): boolean {
    return selectedId.value === conversationId;
  }

  async function select(id: string, syncRoute = true): Promise<void> {
    if (!id) return;
    const generation = ++selectionGeneration;
    selectedId.value = id;
    scroll.resetFollowState();
    options.onSelectionStart?.();
    if (syncRoute && route.query.id !== id) {
      await options.router.replace({ query: { id } });
    }
    loadingConversation.value = true;
    detailError.value = "";
    try {
      const [transcript, handoffResult, evidenceResult, sessionStateResult, sessionWakesResult, turnHealthResult, profileResult] =
        await Promise.all([
          api<any>(
            `/api/v1/conversations/${encodeURIComponent(id)}/messages?limit=100`,
          ),
          api<any>(
            `/api/v1/conversations/${encodeURIComponent(id)}/handoff`,
          ).catch((reason: any) =>
            reason.status === 404 ? null : Promise.reject(reason),
          ),
          api<any>(
            `/api/v1/conversations/${encodeURIComponent(id)}/knowledge/evidence-tray`,
          ).catch(() => ({ evidence: [] })),
          api<any>(
            `/api/v1/agent/session-state/${encodeURIComponent(id)}`,
          ).catch(() => ({ session: null })),
          api<any>(`/api/v1/agent/session-wakes/${encodeURIComponent(id)}`).catch(
            () => ({ wakes: [] }),
          ),
          api<any>(`/api/v1/agent/turn-outcomes/${encodeURIComponent(id)}`).catch(
            () => null,
          ),
          options.loadProfile(id),
        ]);
      // 代际检查：期间已切换到其他会话则丢弃本批数据。
      if (generation !== selectionGeneration) return;
      messages.value = transcript.messages;
      conversationRevision.value = transcript.conversationRevision ?? 0;
      nextCursor.value = transcript.nextCursor ?? null;
      applyHandoff(handoffResult?.handoff ?? null);
      options.onConversationSelected?.(id);
      agentSession.value = sessionStateResult?.session ?? null;
      sessionWakes.value = sessionWakesResult?.wakes ?? [];
      turnHealth.value = turnHealthResult ?? null;
      sessionTraceOpen.value = false;
      sessionTrace.value = null;
      evidence.value = evidenceResult.evidence ?? [];
      options.applyProfile(profileResult.profile);
      const last = messages.value.at(-1);
      if (last)
        void api(`/api/v1/conversations/${encodeURIComponent(id)}/read`, {
          method: "POST",
          body: JSON.stringify({ lastReadMessageId: last.messageId }),
        });
      await nextTick();
      if (generation !== selectionGeneration) return;
      const targetMessageId =
        typeof route.query.messageId === "string" ? route.query.messageId : "";
      // 切会话必达最新：仅 messageId 定位时去锚点，否则无条件滚到底
      if (!(targetMessageId && scroll.scrollToMessage(targetMessageId))) {
        scroll.scrollToLatest(() => generation === selectionGeneration);
      }
    } catch (reason) {
      detailError.value =
        reason instanceof Error ? reason.message : "会话上下文加载失败";
    } finally {
      loadingConversation.value = false;
    }
    flushPendingTranscriptRefresh();
    options.onSettled?.();
  }

  // 加载更早消息：cursor 分页 + scroll anchoring（当前可见消息位置不变）。
  async function loadOlderMessages(): Promise<void> {
    if (!selectedId.value || !nextCursor.value || loadingOlder.value) return;
    loadingOlder.value = true;
    const pane = scroll.pane.value;
    const anchorId = pane ? firstVisibleMessageId(pane) : null;
    const anchorTop = pane?.scrollTop ?? 0;
    try {
      const result = await api<{
        messages: Message[];
        nextCursor?: string | null;
      }>(
        `/api/v1/conversations/${encodeURIComponent(selectedId.value)}/messages?limit=100&before=${encodeURIComponent(nextCursor.value)}`,
      );
      const older = result.messages ?? [];
      nextCursor.value = result.nextCursor ?? null;
      if (older.length) {
        messages.value = [...older, ...messages.value];
        await nextTick();
        restoreAnchor(pane, anchorId, anchorTop);
      }
    } catch (reason) {
      detailError.value =
        reason instanceof Error ? reason.message : "加载更早消息失败";
    } finally {
      loadingOlder.value = false;
    }
  }

  // 后台增量刷新：新消息 append、已有行就地 patch，绝不重载整个会话。
  // 不进入 Skeleton、不重置 Inspector、不清 Draft、不重挂载图片。
  async function refreshTranscriptIncrementally(): Promise<void> {
    if (!selectedId.value) return;
    if (loadingConversation.value) {
      // 初次加载（select 的并发请求）期间到达的事件不能丢：
      // 记下会话，select 结束后补刷一次。
      pendingTranscriptRefreshId = selectedId.value;
      return;
    }
    const conversationId = selectedId.value;
    try {
      const result = await api<{
        messages: Message[];
        conversationRevision?: number;
      }>(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=50`,
      );
      // 响应期间切了会话 → 丢弃（避免旧会话数据覆盖新会话）。
      if (selectedId.value !== conversationId) return;
      const incoming = result.messages ?? [];
      // 两类同步：新增行追加；已存在的行按字段差异就地打补丁——sendState 迁移、
      // 媒体转写/描述回填都必须就地可见，否则只能等整会话重载。
      const merged = mergeTranscriptMessages(messages.value, incoming);
      if (result.conversationRevision !== undefined)
        conversationRevision.value = result.conversationRevision;
      if (merged.patchedCount > 0) messages.value = merged.messages;
      if (!merged.appended.length) return;
      if (scroll.atBottom.value) {
        messages.value = [...messages.value, ...merged.appended];
        await nextTick();
        scroll.scrollToLatest(() => selectedId.value === conversationId);
        // 静默刷新 handoff/依据（不显示任何 loading）
        void refreshContextSilently();
      } else {
        scroll.newMessageCount.value += merged.appended.length;
      }
    } catch {
      // 后台刷新失败静默；下一轮重试，会话本身不受影响。
    }
  }

  // 初次加载期间被丢弃的刷新请求（见 refreshTranscriptIncrementally）。
  let pendingTranscriptRefreshId: string | null = null;
  function flushPendingTranscriptRefresh(): void {
    const pendingId = pendingTranscriptRefreshId;
    pendingTranscriptRefreshId = null;
    if (pendingId && pendingId === selectedId.value)
      void refreshTranscriptIncrementally();
  }

  // 后台静默上下文刷新：只替换数据，不触碰 loading / Inspector / Draft。
  async function refreshContextSilently(): Promise<void> {
    if (!selectedId.value) return;
    const conversationId = selectedId.value;
    const [handoffResult, evidenceResult] = await Promise.all([
      api<any>(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff`,
      ).catch((reason: any) =>
        reason.status === 404 ? null : Promise.reject(reason),
      ),
      api<any>(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/knowledge/evidence-tray`,
      ).catch(() => ({ evidence: [] })),
    ]);
    if (selectedId.value !== conversationId) return;
    applyHandoff(handoffResult?.handoff ?? null);
    const tray = evidenceResult?.evidence;
    if (Array.isArray(tray)) evidence.value = tray;
  }

  async function openSessionTrace(turnId: string | null): Promise<void> {
    if (!turnId) return;
    sessionTraceOpen.value = true;
    sessionTraceLoading.value = true;
    sessionTraceTurnId.value = turnId;
    try {
      sessionTrace.value = await api<any>(
        `/api/v1/agent/decision-trace/${encodeURIComponent(turnId)}`,
      );
    } catch {
      sessionTrace.value = { turn: null, events: [] };
    } finally {
      sessionTraceLoading.value = false;
    }
  }

  return {
    selectedId: selectedId as Ref<string>,
    selected,
    loadingConversation,
    detailError,
    messages: messages as Ref<Message[]>,
    conversationRevision: conversationRevision as Ref<number>,
    nextCursor: nextCursor as Ref<string | null>,
    loadingOlder,
    handoff: handoff as Ref<HandoffDetail | null>,
    agentSession: agentSession as Ref<SessionEpisode | null>,
    sessionWakes,
    turnHealth,
    evidence,
    sessionTraceLoading,
    sessionTraceTurnId,
    sessionTrace,
    sessionTraceOpen,
    lastReplyTurnId,
    isSelected,
    select,
    loadOlderMessages,
    refreshTranscriptIncrementally,
    refreshContextSilently,
    openSessionTrace,
  };
}

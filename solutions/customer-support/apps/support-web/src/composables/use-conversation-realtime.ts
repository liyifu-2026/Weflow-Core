/**
 * 会话新鲜度控制器（Conversation Freshness Controller）。
 *
 * 工作台实时性的唯一机制模块：SSE 失效信号消费（ADR-0009：事件只是失效
 * 信号，不是事实来源——收到即回拉权威状态）、事件风暴按 250ms 尾沿合并、
 * 「15s 对账 / 5s 兜底轮询」降级策略、页面回前台立即对账、以及「AI 正在
 * 思考」的 2s live-turn 轮询。
 *
 * 语义保留（历史踩坑，改动前先读）：
 * - fallback 定时器 clear 之后必须置空：否则「已清除但非空」的引用会让
 *   下一次断线再也装不上兜底定时器（重连后等于完全没有轮询）。
 * - live-turn 连续失败 ≥3 次清空气泡，绝不永久滞留（BFF 重启/下线）。
 * - SSE 重连（非首连）后立即对账一次：断线期间的事件已丢失。
 * - 初次加载期间到达的事件不能丢：调用方（selection）负责 pending 补刷。
 */
import { onUnmounted, ref } from "vue";
import { api } from "../api";

export const LIVE_POLL_MS = 2_000;
/** 实时事件按尾沿合并（一轮 Agent 回复会连发多条事件），对账轮询只兜底。 */
export const REALTIME_DEBOUNCE_MS = 250;
export const RECONCILE_POLL_MS = 15_000;
export const FALLBACK_POLL_MS = 5_000;

export const REALTIME_EVENT_TYPES = [
  "customer_message",
  "agent_message",
  "human_message",
  "handoff_created",
  "handoff_claimed",
  "handoff_transferred",
  "handoff_finished",
  "ownership_changed",
  "brief_updated",
  "conversation_updated",
  // 发送期插话闸门扣留批次：分段变 held（「已拦截」），回拉即可见。
  // 不进白名单时只能等 15s 对账，运营侧看起来像「消息莫名消失了」。
  "reply_interrupted",
] as const;

/** 「AI 正在思考」气泡的阶段文案（turn 事件 → 中文阶段） */
const STAGE_LABELS: Record<string, string> = {
  triaged: "正在判断消息类型…",
  context_built: "正在装配上下文…",
  tool_checkpoint_persisted: "正在规划工具调用…",
  knowledge_retrieved: "知识库检索完成",
  tool_completed: "工具执行完成",
  policy_decided: "正在整理回复…",
  draft_generated: "正在生成回复…",
  model_reasoning: "正在深入思考…",
};
export function liveStageLabel(eventType?: string): string {
  if (!eventType) return "正在处理…";
  return STAGE_LABELS[eventType] ?? "正在处理…";
}

export type LiveThinking = {
  turnId: string;
  status: string;
  startedAt?: string;
  lastEventLabel?: string;
  reasoning?: string | null;
};

/** SSE 消费端回调：模块只发「失效信号」，回拉权威状态由调用方实现。 */
export type ConversationRealtimeHandlers = {
  getSelectedId: () => string;
  /** 对账/兜底 tick 与重连/回前台对账：全量刷新（列表 + 当前会话增量） */
  refreshFromServer: () => void;
  /** 事件合并窗口到期：列表必刷；transcript/context 按事件是否命中当前会话 */
  onRealtimeFlush: (scope: { transcript: boolean; context: boolean }) => void;
};

/** 便于测试注入的 EventSource 最小接口（与 DOM EventSource 结构兼容） */
export type EventSourceLike = {
  onopen: ((...args: never[]) => unknown) | null;
  onerror: ((...args: never[]) => unknown) | null;
  close: () => void;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
};

export type UseConversationRealtime = ReturnType<typeof useConversationRealtime>;

export function useConversationRealtime(options: {
  handlers: ConversationRealtimeHandlers;
  streamUrl?: string;
  fetchLiveTurn?: (conversationId: string) => Promise<any>;
  eventSourceFactory?: (url: string) => EventSourceLike;
}) {
  const {
    handlers,
    streamUrl = "/api/v1/console/events/stream",
    fetchLiveTurn = (conversationId: string) =>
      api<any>(`/api/v1/agent/live-turn/${encodeURIComponent(conversationId)}`),
    eventSourceFactory = (url: string) => new EventSource(url),
  } = options;

  const connected = ref(false);
  const liveThinking = ref<LiveThinking | null>(null);

  let eventSource: EventSourceLike | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let realtimeTimer: ReturnType<typeof setTimeout> | undefined;
  let livePollTimer: ReturnType<typeof setInterval> | null = null;
  let realtimeEverOpened = false;
  let pendingTranscriptRefresh = false;
  let pendingContextRefresh = false;
  let livePollFailures = 0;

  function scheduleReconcile() {
    clearInterval(fallbackTimer);
    fallbackTimer = undefined;
    clearInterval(reconcileTimer);
    // Realtime 健康：15s 对账一次，事件驱动增量更新为主。
    reconcileTimer = setInterval(handlers.refreshFromServer, RECONCILE_POLL_MS);
  }
  function scheduleFallback() {
    clearInterval(reconcileTimer);
    reconcileTimer = undefined;
    // 断开期间 5s 轮询兜底。clear 之后必须置空：否则「已清除但非空」的
    // 引用会让下一次断线再也装不上兜底定时器（重连后等于完全没有轮询）。
    if (!fallbackTimer) fallbackTimer = setInterval(handlers.refreshFromServer, FALLBACK_POLL_MS);
  }

  function handleRealtimeEvent(type: string, raw: Event) {
    let data: { conversationId?: string };
    try {
      data = JSON.parse(String((raw as MessageEvent).data));
    } catch {
      return;
    }
    if (data.conversationId === handlers.getSelectedId()) {
      // 只失效相关资源：消息事件增量补 Transcript，handoff 事件静默刷上下文。
      pendingTranscriptRefresh = true;
      if (type.startsWith("handoff") || type === "ownership_changed")
        pendingContextRefresh = true;
    }
    scheduleRealtimeRefresh();
  }

  /** 事件风暴合并：一轮 Agent 回复会连发 step/tool_note/final 多条事件，
   * 按 250ms 尾沿合并成一次刷新，避免一次回复打出十几个请求。 */
  function scheduleRealtimeRefresh() {
    if (realtimeTimer) clearTimeout(realtimeTimer);
    realtimeTimer = setTimeout(() => {
      realtimeTimer = undefined;
      const scope = { transcript: pendingTranscriptRefresh, context: pendingContextRefresh };
      pendingTranscriptRefresh = false;
      pendingContextRefresh = false;
      handlers.onRealtimeFlush(scope);
    }, REALTIME_DEBOUNCE_MS);
  }

  function connect() {
    if (eventSource) return;
    eventSource = eventSourceFactory(streamUrl);
    eventSource.onopen = () => {
      connected.value = true;
      scheduleReconcile();
      // 重连（非首次连接）后立即对账一次：断线期间的事件已丢失，
      // 不能等下一个对账周期。
      if (realtimeEverOpened) handlers.refreshFromServer();
      realtimeEverOpened = true;
    };
    eventSource.onerror = () => {
      // EventSource 自动重连；断开期间用 5s 轮询兜底。
      connected.value = false;
      scheduleFallback();
    };
    for (const type of REALTIME_EVENT_TYPES) {
      eventSource.addEventListener(type, (event) => {
        handleRealtimeEvent(type, event);
      });
    }
  }

  // ---------- 「AI 正在思考」live-turn 轮询 ----------
  async function pollLiveTurn(conversationId: string) {
    try {
      const result = await fetchLiveTurn(conversationId);
      livePollFailures = 0;
      liveThinking.value = result?.live
        ? {
            turnId: result.live.turnId,
            status: result.live.status,
            startedAt: result.live.startedAt,
            lastEventLabel: liveStageLabel(result.live.lastEvent?.eventType),
            reasoning: result.live.reasoning ?? null,
          }
        : null;
    } catch {
      // 轮询失败静默重试；但连续失败（BFF 重启/下线）时清空气泡，绝不永久滞留
      livePollFailures += 1;
      if (livePollFailures >= 3) {
        liveThinking.value = null;
      }
    }
  }

  function startLivePolling(conversationId: string) {
    stopLivePolling();
    void pollLiveTurn(conversationId);
    livePollTimer = setInterval(() => void pollLiveTurn(conversationId), LIVE_POLL_MS);
  }

  function stopLivePolling() {
    if (livePollTimer) {
      clearInterval(livePollTimer);
      livePollTimer = null;
    }
    liveThinking.value = null;
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") handlers.refreshFromServer();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  onUnmounted(() => {
    stopLivePolling();
    clearInterval(fallbackTimer);
    clearInterval(reconcileTimer);
    clearTimeout(realtimeTimer);
    eventSource?.close();
    eventSource = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  return {
    connected,
    liveThinking,
    connect,
    startLivePolling,
    stopLivePolling,
  };
}

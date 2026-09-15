import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import {
  FALLBACK_POLL_MS,
  LIVE_POLL_MS,
  REALTIME_DEBOUNCE_MS,
  REALTIME_EVENT_TYPES,
  RECONCILE_POLL_MS,
  liveStageLabel,
  useConversationRealtime,
  type ConversationRealtimeHandlers,
  type EventSourceLike,
} from "../src/composables/use-conversation-realtime";

/** 在真实组件 setup 中运行 composable（onUnmounted 需要组件实例） */
function withSetup<T>(fn: () => T): { result: T; unmount: () => void } {
  let result!: T;
  const app = createApp({ setup() { result = fn(); return () => null; } });
  const host = document.createElement("div");
  app.mount(host);
  return { result, unmount: () => app.unmount() };
}

class FakeEventSource implements EventSourceLike {
  static last: FakeEventSource | null = null;
  url: string;
  onopen: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  closed = false;
  private listeners = new Map<string, (event: MessageEvent) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, listener);
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  listenerTypes(): string[] {
    return [...this.listeners.keys()];
  }
}

let selectedId = "conv-1";
const refreshFromServer = vi.fn();
const onRealtimeFlush = vi.fn();
const handlers: ConversationRealtimeHandlers = {
  getSelectedId: () => selectedId,
  refreshFromServer,
  onRealtimeFlush,
};

beforeEach(() => {
  vi.useFakeTimers();
  selectedId = "conv-1";
  refreshFromServer.mockClear();
  onRealtimeFlush.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useConversationRealtime：SSE 生命周期", () => {
  it("connect 建立默认流并订阅全部 10 类事件", () => {
    const { result: rt, unmount } = withSetup(() => useConversationRealtime({ handlers, eventSourceFactory: (url) => new FakeEventSource(url) }));
    rt.connect();
    const es = FakeEventSource.last!;
    expect(es.url).toBe("/api/v1/console/events/stream");
    expect(es.listenerTypes().sort()).toEqual([...REALTIME_EVENT_TYPES].sort());
    unmount();
    expect(es.closed).toBe(true);
  });

  it("首连：connected 置位、进入 15s 对账节拍、不立即对账", () => {
    const { result, unmount } = withSetup(() => useConversationRealtime({ handlers, eventSourceFactory: (url) => new FakeEventSource(url) }));
    result.connect();
    const es = FakeEventSource.last!;
    es.onopen?.();
    expect(result.connected.value).toBe(true);
    expect(refreshFromServer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RECONCILE_POLL_MS);
    expect(refreshFromServer).toHaveBeenCalledTimes(1);
    // 对账期间 5s 兜底不应存在
    vi.advanceTimersByTime(RECONCILE_POLL_MS);
    expect(refreshFromServer).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("断线：回退 5s 兜底轮询；重连：清兜底、立即对账一次、恢复 15s 对账", () => {
    const { result, unmount } = withSetup(() => useConversationRealtime({ handlers, eventSourceFactory: (url) => new FakeEventSource(url) }));
    result.connect();
    const es = FakeEventSource.last!;
    es.onopen?.();
    vi.advanceTimersByTime(RECONCILE_POLL_MS);
    expect(refreshFromServer).toHaveBeenCalledTimes(1);

    es.onerror?.();
    expect(result.connected.value).toBe(false);
    vi.advanceTimersByTime(FALLBACK_POLL_MS);
    expect(refreshFromServer).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(FALLBACK_POLL_MS);
    expect(refreshFromServer).toHaveBeenCalledTimes(3);

    // 重连（浏览器内 EventSource 复用同一实例）
    es.onopen?.();
    expect(result.connected.value).toBe(true);
    expect(refreshFromServer).toHaveBeenCalledTimes(4); // 重连立即对账
    vi.advanceTimersByTime(FALLBACK_POLL_MS);
    expect(refreshFromServer).toHaveBeenCalledTimes(4); // 兜底已拆除
    vi.advanceTimersByTime(RECONCILE_POLL_MS);
    expect(refreshFromServer).toHaveBeenCalledTimes(5); // 回到对账节拍
    unmount();
  });

  it("页面回前台立即对账", () => {
    const { result: rt } = withSetup(() => useConversationRealtime({ handlers, eventSourceFactory: (url) => new FakeEventSource(url) }));
    rt.connect();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refreshFromServer).toHaveBeenCalledTimes(1);
  });
});

describe("useConversationRealtime：失效信号合并", () => {
  it("当前会话的消息事件 → transcript=true；handoff 事件 → context=true；250ms 尾沿合并", () => {
    const { result: rt, unmount } = withSetup(() => useConversationRealtime({ handlers, eventSourceFactory: (url) => new FakeEventSource(url) }));
    rt.connect();
    const es = FakeEventSource.last!;
    es.onopen?.();
    es.emit("customer_message", { conversationId: "conv-1" });
    es.emit("agent_message", { conversationId: "conv-1" });
    es.emit("handoff_created", { conversationId: "conv-1" });
    // 250ms 内重复事件只刷一次
    vi.advanceTimersByTime(REALTIME_DEBOUNCE_MS);
    expect(onRealtimeFlush).toHaveBeenCalledTimes(1);
    expect(onRealtimeFlush).toHaveBeenCalledWith({ transcript: true, context: true });
    unmount();
  });

  it("其他会话的事件只刷列表（scope 全 false）", () => {
    const { result: rt, unmount } = withSetup(() => useConversationRealtime({ handlers, eventSourceFactory: (url) => new FakeEventSource(url) }));
    rt.connect();
    const es = FakeEventSource.last!;
    es.onopen?.();
    es.emit("customer_message", { conversationId: "conv-other" });
    vi.advanceTimersByTime(REALTIME_DEBOUNCE_MS);
    expect(onRealtimeFlush).toHaveBeenCalledWith({ transcript: false, context: false });
    unmount();
  });

  it("reply_interrupted（批次被扣留）→ 当前会话 transcript 刷新", () => {
    const { result: rt, unmount } = withSetup(() => useConversationRealtime({ handlers, eventSourceFactory: (url) => new FakeEventSource(url) }));
    rt.connect();
    const es = FakeEventSource.last!;
    es.onopen?.();
    es.emit("reply_interrupted", { conversationId: "conv-1" });
    vi.advanceTimersByTime(REALTIME_DEBOUNCE_MS);
    // 回拉后分段显示为「已拦截」；不在白名单则只能等 15s 对账
    expect(onRealtimeFlush).toHaveBeenCalledWith({ transcript: true, context: false });
    unmount();
  });

  it("坏 JSON 帧直接丢弃", () => {
    const { result: rt, unmount } = withSetup(() => useConversationRealtime({ handlers, eventSourceFactory: (url) => new FakeEventSource(url) }));
    rt.connect();
    const es = FakeEventSource.last!;
    es.onopen?.();
    es.listeners.get("customer_message")!(new MessageEvent("customer_message", { data: "{oops" }));
    vi.advanceTimersByTime(REALTIME_DEBOUNCE_MS);
    expect(onRealtimeFlush).not.toHaveBeenCalled();
    unmount();
  });

  it("getSelectedId 变化后失效按新会话判定", () => {
    const { result: rt, unmount } = withSetup(() => useConversationRealtime({ handlers, eventSourceFactory: (url) => new FakeEventSource(url) }));
    rt.connect();
    const es = FakeEventSource.last!;
    es.onopen?.();
    selectedId = "conv-2";
    es.emit("ownership_changed", { conversationId: "conv-2" });
    vi.advanceTimersByTime(REALTIME_DEBOUNCE_MS);
    expect(onRealtimeFlush).toHaveBeenCalledWith({ transcript: true, context: true });
    unmount();
  });
});

describe("useConversationRealtime：live-turn 轮询", () => {
  function setup(fetchLiveTurn: (id: string) => Promise<any>) {
    const host = withSetup(() => useConversationRealtime({ handlers, eventSourceFactory: (url) => new FakeEventSource(url), fetchLiveTurn }));
    return host;
  }

  it("有进行中的 turn → liveThinking 填充（阶段文案映射）；无 → null", async () => {
    const fetchLiveTurn = vi.fn()
      .mockResolvedValueOnce({
        live: { turnId: "t1", status: "running", startedAt: "x", lastEvent: { eventType: "model_reasoning" }, reasoning: "思考中" },
      })
      .mockResolvedValue({ live: null });
    const { result, unmount } = setup(fetchLiveTurn);
    result.startLivePolling("conv-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(result.liveThinking.value).toEqual({
      turnId: "t1",
      status: "running",
      startedAt: "x",
      lastEventLabel: liveStageLabel("model_reasoning"),
      reasoning: "思考中",
    });
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(result.liveThinking.value).toBeNull();
    expect(fetchLiveTurn).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("连续失败 ≥3 次清空气泡，绝不永久滞留", async () => {
    const fetchLiveTurn = vi.fn().mockRejectedValue(new Error("down"));
    const { result, unmount } = setup(fetchLiveTurn);
    result.startLivePolling("conv-1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
    expect(result.liveThinking.value).toBeNull(); // 第 3 次失败清空
    unmount();
  });

  it("切会话时 stopLivePolling 清空气泡并重置", async () => {
    const fetchLiveTurn = vi.fn().mockResolvedValue({
      live: { turnId: "t1", status: "queued", startedAt: "x", lastEvent: null, reasoning: null },
    });
    const { result, unmount } = setup(fetchLiveTurn);
    result.startLivePolling("conv-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(result.liveThinking.value).not.toBeNull();
    result.stopLivePolling();
    expect(result.liveThinking.value).toBeNull();
    const calls = fetchLiveTurn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 3);
    expect(fetchLiveTurn.mock.calls.length).toBe(calls); // 定时器已停
    unmount();
  });
});

describe("liveStageLabel", () => {
  it("已知阶段映射 + 未知/缺省兜底", () => {
    expect(liveStageLabel("model_reasoning")).toBe("正在深入思考…");
    expect(liveStageLabel("who_knows")).toBe("正在处理…");
    expect(liveStageLabel(undefined)).toBe("正在处理…");
  });
});

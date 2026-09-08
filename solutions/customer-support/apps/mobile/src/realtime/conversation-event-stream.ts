/**
 * 会话事件流（SSE）
 *
 * 通过 expo/fetch 的流式响应订阅 Core 的 /api/v1/console/events/stream，
 * 事件只作「失效信号」：收到后回拉权威状态，不做任何本地事实推断。
 *
 * - 断线指数退避重连（1s → 30s），连上即重置；
 * - 应用进后台断开、回前台立即重连（回前台时调用方另有对账刷新）；
 * - 运行时不支持流式响应（无 response.body）时永久退回轮询，不再重试。
 */
import { AppState } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { apiBaseUrl } from "@/api/config";
import { loadSession } from "@/auth/session";
import {
  createSseEventParser,
  type ConversationStreamEvent,
} from "./sse-parser";

export type { ConversationStreamEvent };

type Listener = (event: ConversationStreamEvent) => void;

/** 消费端去抖：一轮 Agent 回复会连发多条事件，按尾沿合并成一次回拉 */
export const REALTIME_REFRESH_DEBOUNCE_MS = 300;

const EVENT_PATH = "/api/v1/console/events/stream";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const listeners = new Set<Listener>();
let controller: AbortController | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempts = 0;
let started = false;
let active = AppState.currentState === "active";
/** 运行时缺少流式响应能力：永久退回轮询，避免无意义的重连风暴 */
let unsupported = false;

/** 订阅会话事件（全应用共享一条连接，多个屏幕各自过滤） */
export function subscribeConversationEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 启动事件流：应用生命周期内单例，重复调用无副作用 */
export function startConversationEventStream(): void {
  if (started) return;
  started = true;
  AppState.addEventListener("change", (state) => {
    const nextActive = state === "active";
    if (nextActive === active) return;
    active = nextActive;
    if (active) {
      reconnectAttempts = 0;
      void connect();
    } else {
      disconnect();
    }
  });
  void connect();
}

function disconnect(): void {
  controller?.abort();
  controller = undefined;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function scheduleReconnect(): void {
  if (unsupported || !active || reconnectTimer) return;
  const delay = Math.min(
    RECONNECT_BASE_MS * 2 ** reconnectAttempts,
    RECONNECT_MAX_MS,
  );
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  if (controller || unsupported || !active) return;
  const abort = new AbortController();
  controller = abort;
  try {
    const session = await loadSession();
    if (!session) {
      // 未登录：等退避重连（登录成功后下一次尝试即可连上）
      throw new Error("no session");
    }
    const response = await expoFetch(`${apiBaseUrl}${EVENT_PATH}`, {
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        accept: "text/event-stream",
      },
      signal: abort.signal,
    });
    if (!response.ok) {
      throw new Error(`event stream rejected: ${String(response.status)}`);
    }
    if (!response.body) {
      // 运行时不支持流式响应：退回轮询，不再重试。
      unsupported = true;
      return;
    }
    reconnectAttempts = 0;
    await readEventStream(response.body, abort.signal);
  } catch {
    // 网络抖动 / 断线 / 未登录：交给退避重连，不打扰用户。
  } finally {
    if (controller === abort) controller = undefined;
    scheduleReconnect();
  }
}

/** 逐块读取并交给解析器；跨块切帧由解析器的缓冲处理。 */
async function readEventStream(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseEventParser();
  try {
    for (;;) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) return;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        for (const listener of listeners) listener(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

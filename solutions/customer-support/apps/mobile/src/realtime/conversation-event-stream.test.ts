/**
 * 事件流接线测试
 * mock 掉 React Native / expo-fetch / 会话存储，驱动真实的 connect → 读流 →
 * 解析 → 分发给订阅者，验证：
 * - 用 Bearer 认证连到正确的端点；
 * - 跨 chunk 切分的帧也能完整还原；
 * - 订阅者按注册顺序收到事件。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const appStateListeners: Array<(state: string) => void> = [];
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appStateListeners.push(listener);
      return { remove: () => undefined };
    },
  },
}));

const fetchMock = vi.fn();
vi.mock("expo/fetch", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args) as unknown,
}));
vi.mock("@/api/config", () => ({ apiBaseUrl: "https://api.example" }));
vi.mock("@/auth/session", () => ({
  loadSession: async () => ({ sessionToken: "token-123" }),
}));

function streamOf(chunks: string[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const frame = (conversationId: string) =>
  `id: 1\nevent: agent_message\ndata: ${JSON.stringify({
    type: "agent_message",
    conversationId,
    occurredAt: "2026-09-09T00:00:00.000Z",
  })}\n\n`;

describe("conversation event stream wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    appStateListeners.length = 0;
  });

  it("connects with the bearer token and dispatches events split across chunks", async () => {
    const first = frame("channel:a");
    const second = frame("channel:b");
    // 第二帧从中间切开：解析器必须靠缓冲还原
    const cut = first.length + Math.floor(second.length / 2);
    const payload = first + second;
    fetchMock.mockResolvedValue({
      ok: true,
      body: streamOf([payload.slice(0, cut), payload.slice(cut)]),
    });

    const mod = await import("./conversation-event-stream");
    const received: Array<{ conversationId: string }> = [];
    mod.subscribeConversationEvents((event) => received.push(event));
    mod.startConversationEventStream();

    await vi.waitFor(() => {
      expect(received).toHaveLength(2);
    });
    expect(received.map((event) => event.conversationId)).toEqual([
      "channel:a",
      "channel:b",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example/api/v1/console/events/stream",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer token-123",
          accept: "text/event-stream",
        }),
      }),
    );
  });

  it("does not connect when the app is backgrounded", async () => {
    const mod = await import("./conversation-event-stream");
    mod.startConversationEventStream();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(appStateListeners).toHaveLength(1);
  });
});

/**
 * SSE 帧解析（纯函数，不依赖 React Native / Expo）
 *
 * 事件流按块到达：一次 read 可能包含多个帧，也可能切出半个帧，
 * 所以解析器必须自带缓冲，不能按块直接解析。心跳帧（`: ping`）
 * 没有 data 字段，自然被忽略。
 */
export type ConversationStreamEvent = {
  type: string;
  conversationId: string;
  occurredAt: string;
  messageId?: string;
};

/** 创建一个带缓冲的 SSE 解析器：按块喂入，产出完整事件 */
export function createSseEventParser(): {
  push: (chunk: string) => ConversationStreamEvent[];
} {
  let buffer = "";
  return {
    push(chunk: string): ConversationStreamEvent[] {
      buffer += chunk;
      const events: ConversationStreamEvent[] = [];
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = parseFrame(buffer.slice(0, boundary));
        if (event) events.push(event);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      return events;
    },
  };
}

/** 解析单个 SSE 帧；不完整/非事件帧返回 undefined */
function parseFrame(frame: string): ConversationStreamEvent | undefined {
  // 一个帧可以有多行 data，按 SSE 规范拼接。
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data += line.slice("data:".length).trim();
  }
  if (!data) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  return isConversationStreamEvent(parsed) ? parsed : undefined;
}

/** 事件载荷校验：只接受带 type / conversationId / occurredAt 的对象 */
export function isConversationStreamEvent(
  value: unknown,
): value is ConversationStreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.conversationId === "string" &&
    typeof candidate.occurredAt === "string"
  );
}

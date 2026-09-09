/**
 * 发送回执与实时合并的竞态测试
 *
 * 场景：SSE 事件（服务端消息）可能比 POST 响应先到——此时列表里还是
 * local: 乐观占位。Core 的转录会回带 clientRequestId，合并据此移除占位；
 * 即便回带缺失，发送回执路径也必须按 messageId 去重，不能出现重复气泡。
 */
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "./api";
import { mergeTimelineMessages } from "./timeline";

function serverMessage(
  messageId: string,
  occurredAt: string,
  extra?: { clientRequestId?: string },
): ServerMessage {
  return {
    messageId,
    actorType: "user",
    direction: "outbound",
    contentType: "text",
    text: "已发送",
    sendState: "pending",
    occurredAt,
    ...extra,
  };
}

const at = "2026-08-03T10:02:00.000Z";
const placeholder: ServerMessage = {
  ...serverMessage("local:req-1", at),
  text: "发送中",
  clientRequestId: "req-1",
};

describe("send ack vs realtime merge race", () => {
  it("removes the optimistic placeholder when the server row echoes clientRequestId", () => {
    const merged = mergeTimelineMessages(
      [placeholder],
      [serverMessage("srv-1", at, { clientRequestId: "req-1" })],
    );
    expect(merged.map((item) => item.messageId)).toEqual(["srv-1"]);
  });

  it("does not duplicate the server row when the ack arrives after the merge", () => {
    // SSE 先到：占位被回执移除，服务端消息进入列表
    const merged = mergeTimelineMessages(
      [placeholder],
      [serverMessage("srv-1", at, { clientRequestId: "req-1" })],
    );
    // POST 响应随后到达：先移除占位（已不在），再按 messageId 合并
    const ack = serverMessage("srv-1", at);
    const afterAck = (() => {
      const withoutPlaceholder = merged.filter(
        (item) => item.clientRequestId !== "req-1",
      );
      return mergeTimelineMessages(withoutPlaceholder, [ack]);
    })();
    expect(afterAck.map((item) => item.messageId)).toEqual(["srv-1"]);
  });

  it("still dedupes by messageId when the server row lacks clientRequestId", () => {
    // 老服务端不回带 clientRequestId：占位仍在，服务端行也已合并
    const merged = mergeTimelineMessages([placeholder], [serverMessage("srv-1", at)]);
    expect(merged.map((item) => item.messageId)).toEqual([
      "local:req-1",
      "srv-1",
    ]);
    const ack = serverMessage("srv-1", at);
    const withoutPlaceholder = merged.filter(
      (item) => item.clientRequestId !== "req-1",
    );
    const afterAck = mergeTimelineMessages(withoutPlaceholder, [ack]);
    expect(afterAck.map((item) => item.messageId)).toEqual(["srv-1"]);
  });
});

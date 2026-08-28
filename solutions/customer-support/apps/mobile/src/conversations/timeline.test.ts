/**
 * 聊天时间线合并测试
 * 验证分页预追加、实时更新合并和新消息计数的正确性。
 */
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "./api";
import { countNewTimelineMessages, mergeTimelineMessages } from "./timeline";

function message(messageId: string, minute: number, text = messageId): ServerMessage {
  return {
    messageId,
    actorType: "customer",
    direction: "inbound",
    contentType: "text",
    text,
    occurredAt: `2026-08-03T10:${String(minute).padStart(2, "0")}:00.000Z`,
  };
}

describe("conversation timeline", () => {
  it("prepends older pages without duplicating the cursor boundary", () => {
    expect(
      mergeTimelineMessages(
        [message("m2", 2), message("m3", 3)],
        [message("m1", 1), message("m2", 2)],
      ).map((item) => item.messageId),
    ).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps loaded history while merging a live update", () => {
    expect(
      mergeTimelineMessages(
        [message("m1", 1), message("m2", 2, "old")],
        [message("m2", 2, "confirmed"), message("m3", 3)],
      ).map((item) => item.text),
    ).toEqual(["m1", "confirmed", "m3"]);
  });

  it("counts only messages that are not already visible", () => {
    expect(
      countNewTimelineMessages(
        [message("m1", 1), message("m2", 2)],
        [message("m2", 2), message("m3", 3), message("m4", 4)],
      ),
    ).toBe(2);
  });

  it("replaces the optimistic local copy once the server ack arrives", () => {
    const pending: ServerMessage & { clientRequestId?: string } = {
      ...message("local:req-1", 2, "发送中"),
      clientRequestId: "req-1",
    };
    const ack = {
      ...message("srv-1", 2, "已发送"),
      clientRequestId: "req-1",
    } as ServerMessage & { clientRequestId?: string };
    const merged = mergeTimelineMessages([message("m1", 1), pending], [ack]);
    expect(merged.map((item) => item.messageId)).toEqual(["m1", "srv-1"]);
    expect(
      merged.filter((item) => item.messageId.startsWith("local:")),
    ).toEqual([]);
  });

  it("does not count the server ack of a known local send as a new message", () => {
    const pending: ServerMessage & { clientRequestId?: string } = {
      ...message("local:req-1", 2),
      clientRequestId: "req-1",
    };
    const ack = {
      ...message("srv-1", 2),
      clientRequestId: "req-1",
    } as ServerMessage & { clientRequestId?: string };
    expect(countNewTimelineMessages([pending], [ack])).toBe(0);
  });
});

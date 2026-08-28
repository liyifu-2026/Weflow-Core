import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUP_CHAT_POLICY,
  shouldRespondToGroupMessage,
  type GroupChatPolicy,
} from "../modules/agent/application/group-chat-policy.js";
import { buildOutboundPayload } from "../modules/conversations/application/process-outbound-messages.js";

describe("ADR-0006 群聊引用/@ 策略", () => {
  it("默认策略：被 @ 必回，未 @ 不回", () => {
    expect(
      shouldRespondToGroupMessage(DEFAULT_GROUP_CHAT_POLICY, {
        text: "hello",
        mentioned: true,
      }),
    ).toBe(true);
    expect(
      shouldRespondToGroupMessage(DEFAULT_GROUP_CHAT_POLICY, {
        text: "hello",
        mentioned: false,
      }),
    ).toBe(false);
  });

  it("关键词命中即回", () => {
    const policy: GroupChatPolicy = {
      ...DEFAULT_GROUP_CHAT_POLICY,
      keywords: ["故障", "维修"],
    };
    expect(
      shouldRespondToGroupMessage(policy, {
        text: "我的设备出现故障了",
        mentioned: false,
      }),
    ).toBe(true);
    expect(
      shouldRespondToGroupMessage(policy, {
        text: "今天天气不错",
        mentioned: false,
      }),
    ).toBe(false);
  });

  it("acceptAll 时按概率回复（概率 1 必回，0 不回）", () => {
    const always: GroupChatPolicy = {
      ...DEFAULT_GROUP_CHAT_POLICY,
      acceptAll: true,
      responseProbability: 1,
    };
    expect(
      shouldRespondToGroupMessage(always, {
        text: "any",
        mentioned: false,
      }),
    ).toBe(true);
    const never: GroupChatPolicy = {
      ...DEFAULT_GROUP_CHAT_POLICY,
      acceptAll: true,
      responseProbability: 0,
    };
    expect(
      shouldRespondToGroupMessage(never, {
        text: "any",
        mentioned: false,
      }),
    ).toBe(false);
  });
});

describe("ADR-0006 出站 payload 构建", () => {
  it("有引用 → reply payload", () => {
    const payload = buildOutboundPayload({
      operationId: "op-1",
      conversationId: "room-1",
      text: "收到",
      replyToChannelMessageId: "wx-msg-99",
      mentionContactRefs: [],
      sendState: "pending",
    });
    expect(payload).toEqual({
      kind: "reply",
      text: "收到",
      replyToChannelMessageId: "wx-msg-99",
    });
  });

  it("有 @ 提及 → mention payload", () => {
    const payload = buildOutboundPayload({
      operationId: "op-2",
      conversationId: "room-1",
      text: "你好",
      mentionContactRefs: ["wxid_a", "wxid_b"],
      sendState: "pending",
    });
    expect(payload).toEqual({
      kind: "mention",
      text: "你好",
      mentionContactRefs: ["wxid_a", "wxid_b"],
    });
  });

  it("无引用无提及 → 纯文本 payload", () => {
    const payload = buildOutboundPayload({
      operationId: "op-3",
      conversationId: "wxid_x",
      text: "普通回复",
      sendState: "pending",
    });
    expect(payload).toEqual({ kind: "text", text: "普通回复" });
  });
});

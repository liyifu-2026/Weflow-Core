import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUP_CHAT_POLICY,
  extractGroupChatSettings,
  resolveGroupChatPolicy,
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

describe("可配置群聊策略（extractGroupChatSettings / resolveGroupChatPolicy）", () => {
  it("无配置 → 完全回落默认（仅@，无冷却）", () => {
    const settings = extractGroupChatSettings(undefined);
    const resolved = resolveGroupChatPolicy(settings, "12345@chatroom");
    expect(resolved.policy).toEqual(DEFAULT_GROUP_CHAT_POLICY);
    expect(resolved.cooldown).toEqual({ minutes: 0, maxReplies: 2 });
    expect(resolved.off).toBe(false);
  });

  it("畸形配置逐项回落（不抛错）", () => {
    const settings = extractGroupChatSettings({
      groupChat: {
        mode: "not-a-mode",
        keywords: ["ok", 42, null],
        cooldownMinutes: "x",
        probability: 5,
      },
    });
    const resolved = resolveGroupChatPolicy(settings, "1@chatroom");
    expect(resolved.policy).toEqual(DEFAULT_GROUP_CHAT_POLICY);
  });

  it("mention_or_keyword：关键词命中即回", () => {
    const settings = extractGroupChatSettings({
      groupChat: { mode: "mention_or_keyword", keywords: ["报价"] },
    });
    const resolved = resolveGroupChatPolicy(settings, "1@chatroom");
    expect(resolved.policy.replyWhenMentioned).toBe(true);
    expect(resolved.policy.acceptAll).toBe(false);
    expect(
      shouldRespondToGroupMessage(resolved.policy, {
        text: "给我一份报价",
        mentioned: false,
      }),
    ).toBe(true);
  });

  it("accept_all：概率字段生效", () => {
    const settings = extractGroupChatSettings({
      groupChat: { mode: "accept_all", probability: 1 },
    });
    const resolved = resolveGroupChatPolicy(settings, "1@chatroom");
    expect(resolved.policy.acceptAll).toBe(true);
    expect(resolved.policy.responseProbability).toBe(1);
  });

  it("off 模式：该群静默", () => {
    const settings = extractGroupChatSettings({
      groupChat: { mode: "off" },
    });
    expect(resolveGroupChatPolicy(settings, "1@chatroom").off).toBe(true);
  });

  it("群 override 优先于全局", () => {
    const settings = extractGroupChatSettings({
      groupChat: {
        mode: "off",
        groupOverrides: [
          {
            conversationRef: "999@chatroom",
            mode: "mention_or_keyword",
            keywords: ["价格"],
          },
        ],
      },
    });
    // 其他群走全局 off
    expect(resolveGroupChatPolicy(settings, "1@chatroom").off).toBe(true);
    // 覆盖群走自己的关键词策略
    const overridden = resolveGroupChatPolicy(settings, "999@chatroom");
    expect(overridden.off).toBe(false);
    expect(
      shouldRespondToGroupMessage(overridden.policy, {
        text: "这台机器价格多少",
        mentioned: false,
      }),
    ).toBe(true);
  });

  it("冷却参数容错提取", () => {
    const settings = extractGroupChatSettings({
      groupChat: { mode: "mention_only", cooldownMinutes: 999, maxRepliesPerCooldown: 0 },
    });
    const resolved = resolveGroupChatPolicy(settings, "1@chatroom");
    // 999 超上限回落 0（关冷却）；maxReplies < 1 回落 2
    expect(resolved.cooldown).toEqual({ minutes: 0, maxReplies: 2 });
  });
});

describe("ADR-0006 出站 payload 构建", () => {  it("有引用 → reply payload", () => {
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

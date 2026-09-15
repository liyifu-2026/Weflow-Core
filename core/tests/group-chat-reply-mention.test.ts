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
  it("默认策略（ADR-0011 引擎缺省 botNames 空）：回落 Host mentioned fail-open", () => {
    expect(
      shouldRespondToGroupMessage(DEFAULT_GROUP_CHAT_POLICY, {
        text: "@客服 hello",
        mentioned: true,
      }),
    ).toBe(true);
    expect(
      shouldRespondToGroupMessage(DEFAULT_GROUP_CHAT_POLICY, {
        text: "hello",
        mentioned: false,
      }),
    ).toBe(false);
    // botNames 空 = 未配置：任何 @（fail-open）都算被点名——与历史"未配置"行为一致；
    // 精确昵称匹配由部署种子/设置下发 botNames 后生效。
    expect(
      shouldRespondToGroupMessage(DEFAULT_GROUP_CHAT_POLICY, {
        text: "@张三 你看这个",
        mentioned: true,
      }),
    ).toBe(true);
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

describe("botNames 文本匹配 + 对话线程配置（2026-09-07 群聊体验批）", () => {
  const policyWithBot = (botNames: string[]): GroupChatPolicy => ({
    ...DEFAULT_GROUP_CHAT_POLICY,
    botNames,
  });

  it("botNames 配置后：@昵称文本命中即响应，不再依赖 Host mentioned", () => {
    const policy = policyWithBot(["客服"]);
    expect(
      shouldRespondToGroupMessage(policy, {
        text: "@客服 v9打不开怎么办",
        mentioned: false, // Host 漏判也不影响
      }),
    ).toBe(true);
  });

  it("botNames 配置后：@别人不算被点名（Host fail-open 不再误触发）", () => {
    const policy = policyWithBot(["客服"]);
    expect(
      shouldRespondToGroupMessage(policy, {
        text: "@张三 你看这个",
        mentioned: true, // Host fail-open 误标
      }),
    ).toBe(false);
  });

  it("botNames 为空：回落 Host mentioned 判定（既有行为）", () => {
    const policy = policyWithBot([]);
    expect(
      shouldRespondToGroupMessage(policy, {
        text: "随便什么",
        mentioned: true,
      }),
    ).toBe(true);
  });

  it("botNames 解析：缺省 ['客服']；非法项过滤；threadTtlMinutes 缺省 15、越界回落", () => {
    const parsed = extractGroupChatSettings({
      groupChat: {
        mode: "mention_only",
        botNames: ["客服", "  ", 42],
        threadTtlMinutes: 999,
      },
    });
    expect(parsed.global.policy.botNames).toEqual(["客服"]);
    expect(parsed.global.threadTtlMinutes).toBe(15); // 越界回落默认

    const legacy = extractGroupChatSettings({});
    expect(legacy.global.policy.botNames).toEqual([]); // ADR-0011：引擎缺省中立（空 = 回落 Host fail-open）
    expect(legacy.global.threadTtlMinutes).toBe(0); // 未配置 mode = 旧行为（无线程）
  });
});

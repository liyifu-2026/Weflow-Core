/**
 * 出站纯决策核（outbound-step-decision）表驱动测试。
 * 分段阻塞 / 打字节拍 / kill-switch 扣留 / 插话闸门规则此前只能靠重建
 * DB fixture 的集成测试覆盖；纯函数化后在此逐格钉住。
 */
import { describe, expect, it } from "vitest";
import {
  interSegmentDelayMs,
  interjectionGate,
  priorSegmentGate,
  shouldHoldForKillSwitch,
} from "../modules/conversations/application/outbound-step-decision.js";
import { parseAgentReplyBatchId } from "../modules/conversations/application/message-service.js";

const NOW = new Date("2026-09-09T00:10:00.000Z");

describe("priorSegmentGate", () => {
  const base = {
    hasUnsentPrior: false,
    deliveredCopyExists: false,
    priorSentAt: null,
    text: "好的，收到。",
    messageId: "msg-1",
    now: NOW,
  };

  it("无前序分段：直接 ok", () => {
    expect(priorSegmentGate(base)).toBe("ok");
  });

  it("前序仍 pending/submitting 且无 delivered 副本：blocked", () => {
    expect(priorSegmentGate({ ...base, hasUnsentPrior: true })).toBe("blocked");
  });

  it("前序仍在途但已有 delivered 副本：解除 blocked（只看字节拍）", () => {
    // priorSentAt 为 null → 无 pacing 判定 → ok
    expect(
      priorSegmentGate({
        ...base,
        hasUnsentPrior: true,
        deliveredCopyExists: true,
      }),
    ).toBe("ok");
  });

  it("前序刚发出、字节拍未到：pacing", () => {
    const delay = interSegmentDelayMs(base.text, base.messageId);
    expect(
      priorSegmentGate({
        ...base,
        priorSentAt: new Date(NOW.getTime() - Math.max(delay - 100, 0)),
      }),
    ).toBe("pacing");
  });

  it("前序发出已超过字节拍：ok", () => {
    const delay = interSegmentDelayMs(base.text, base.messageId);
    expect(
      priorSegmentGate({
        ...base,
        priorSentAt: new Date(NOW.getTime() - delay - 1_000),
      }),
    ).toBe("ok");
  });

  it("delay 确定性：同 messageId 反复计算结果稳定、范围有界", () => {
    const a = interSegmentDelayMs("你好", "seed-msg");
    const b = interSegmentDelayMs("你好", "seed-msg");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(600);
    expect(a).toBeLessThanOrEqual(7_200);
  });
});

describe("shouldHoldForKillSwitch", () => {
  it("agent + auto_send OFF + 非 unknown → 扣留", () => {
    expect(
      shouldHoldForKillSwitch({
        actorType: "agent",
        sendState: "pending",
        autoSendEnabled: false,
      }),
    ).toBe(true);
  });

  it("unknown 不扣留（无法安全对账）", () => {
    expect(
      shouldHoldForKillSwitch({
        actorType: "agent",
        sendState: "unknown",
        autoSendEnabled: false,
      }),
    ).toBe(false);
  });

  it.each(["user", "system"] as const)(
    "%s 消息永远允许（含程序化 handoff 确认语）",
    (actorType) => {
      expect(
        shouldHoldForKillSwitch({
          actorType,
          sendState: "pending",
          autoSendEnabled: false,
        }),
      ).toBe(false);
    },
  );

  it("auto_send ON：不扣留", () => {
    expect(
      shouldHoldForKillSwitch({
        actorType: "agent",
        sendState: "pending",
        autoSendEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("interjectionGate", () => {
  const base = {
    gateEnabled: true,
    chatType: "private" as const,
    isAgentReplyBatch: true,
    isToolResultVariant: false,
    triggerActorId: "wxid_customer" as string | null,
    interjections: [{ actorId: "wxid_customer" }] as {
      actorId: string | null;
    }[],
  };

  it("开关 OFF：永远放行（现状行为逐字节一致）", () => {
    expect(interjectionGate({ ...base, gateEnabled: false })).toBe("send");
  });

  it("非 agent 批次（human/system、handoff-farewell）：放行", () => {
    expect(interjectionGate({ ...base, isAgentReplyBatch: false })).toBe(
      "send",
    );
  });

  it.each(["private", "group"] as const)(
    "%s：tool-result 变体豁免（工具结论不可再生，对齐吸收矩阵 carry-through）",
    (chatType) => {
      expect(
        interjectionGate({ ...base, chatType, isToolResultVariant: true }),
      ).toBe("send");
    },
  );

  it.each(["private", "group"] as const)("%s：无插话 → 放行", (chatType) => {
    expect(interjectionGate({ ...base, chatType, interjections: [] })).toBe(
      "send",
    );
  });

  it("私聊：任何新入站都扣留", () => {
    expect(
      interjectionGate({
        ...base,
        interjections: [{ actorId: "wxid_stranger" }],
      }),
    ).toBe("hold");
    expect(
      interjectionGate({ ...base, interjections: [{ actorId: null }] }),
    ).toBe("hold");
  });

  it("群聊：原提问者插话 → 扣留", () => {
    expect(
      interjectionGate({
        ...base,
        chatType: "group",
        triggerActorId: "wxid_customer",
        interjections: [{ actorId: "wxid_customer" }],
      }),
    ).toBe("hold");
  });

  it("群聊：路人插话不扣（嘈杂群回复必须发得完）", () => {
    expect(
      interjectionGate({
        ...base,
        chatType: "group",
        triggerActorId: "wxid_customer",
        interjections: [{ actorId: "wxid_other" }, { actorId: null }],
      }),
    ).toBe("send");
  });

  it("群聊：wake 轮无触发者基准 → 保守放行", () => {
    expect(
      interjectionGate({
        ...base,
        chatType: "group",
        triggerActorId: null,
      }),
    ).toBe("send");
  });
});

describe("parseAgentReplyBatchId", () => {
  it("解析四种变体（createAgentReply 构造格式的镜像）", () => {
    expect(parseAgentReplyBatchId("agent-reply:turn:m1")).toEqual({
      turnId: "turn:m1",
      variant: "direct",
    });
    expect(parseAgentReplyBatchId("agent-reply:turn:m1:tool-result")).toEqual({
      turnId: "turn:m1",
      variant: "tool_result",
    });
    expect(parseAgentReplyBatchId("agent-reply:turn:m1:tool-note")).toEqual({
      turnId: "turn:m1",
      variant: "tool_note",
    });
    expect(parseAgentReplyBatchId("agent-reply:turn:m1:step:2")).toEqual({
      turnId: "turn:m1",
      variant: "step",
    });
  });

  it("turnId 含 step: 字样时按最后一个 :step:N 切分", () => {
    // 防御：turn:{messageId} 的 messageId 段若含 ":step:"（当前不会），
    // 解析仍以尾部数字段为准
    expect(parseAgentReplyBatchId("agent-reply:turn:wake:x:step:1")).toEqual({
      turnId: "turn:wake:x",
      variant: "step",
    });
  });

  it("非 agent-reply 前缀返回 null（handoff-farewell 等不进闸门）", () => {
    expect(parseAgentReplyBatchId("handoff-farewell:event-1")).toBeNull();
    expect(parseAgentReplyBatchId("")).toBeNull();
  });
});

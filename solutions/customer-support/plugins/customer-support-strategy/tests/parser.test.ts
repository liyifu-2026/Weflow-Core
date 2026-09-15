import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCustomerSupportResponse } from "../dist/parser.js";
import {
  DEFAULT_REPLY_WAIT_MS,
  NEXT_ACTION_VALUES,
  WAIT_MS,
} from "../dist/decision-protocol.js";

function parse(raw: Record<string, unknown>) {
  return parseCustomerSupportResponse(JSON.stringify(raw));
}

function expectThrows(fn: () => unknown, re: RegExp) {
  assert.throws(fn, re);
}

test("reply：完整字段（segments + wait_ms + nudge_text）", () => {
  const action = parse({
    next_action: "reply",
    reply_segments: ["好的。", "我看下。"],
    wait_ms: 80_000,
    nudge_text: "还在吗",
  });
  assert.deepEqual(action, {
    kind: "reply",
    segments: ["好的。", "我看下。"],
    waitMs: 80_000,
    nudgeText: "还在吗",
  });
});

test("reply：reply_text / reply 键兜底（视觉模型丢键场景）", () => {
  // 缺 wait_ms → 补业务默认（说完交权，见下一条用例）
  assert.deepEqual(parse({ next_action: "reply", reply_text: "你好" }), {
    kind: "reply",
    segments: ["你好"],
    waitMs: DEFAULT_REPLY_WAIT_MS,
  });
  assert.deepEqual(parse({ next_action: "reply", reply: "在的" }), {
    kind: "reply",
    segments: ["在的"],
    waitMs: DEFAULT_REPLY_WAIT_MS,
  });
});

test("reply/ask 缺 wait_ms → 补业务默认「说完交权」；显式值优先；可显式关闭", () => {
  // 缺省：引擎把「不带 wait_ms」读作继续工作，客服场景必须反过来——
  // 排查步骤要停在客户反馈上（实测：同一步骤被续步复读了三次）。
  assert.equal(
    (
      parse({ next_action: "reply", reply_segments: ["先看灯亮不亮。"] }) as {
        waitMs?: number;
      }
    ).waitMs,
    DEFAULT_REPLY_WAIT_MS,
  );
  assert.equal(
    (
      parse({
        next_action: "ask_for_information",
        reply_segments: ["什么型号？"],
      }) as { waitMs?: number }
    ).waitMs,
    DEFAULT_REPLY_WAIT_MS,
  );
  // 模型显式给了 wait_ms → 用模型值，不覆盖
  assert.equal(
    (
      parse({
        next_action: "reply",
        reply_segments: ["好的。"],
        wait_ms: 80_000,
      }) as { waitMs?: number }
    ).waitMs,
    80_000,
  );
  // 业务显式关闭（null）→ 回到引擎语义：不带 wait_ms
  const continued = parseCustomerSupportResponse(
    JSON.stringify({
      next_action: "reply",
      reply_segments: ["先看灯亮不亮。"],
    }),
    { defaultReplyWaitMs: null },
  ) as { waitMs?: number };
  assert.equal(continued.waitMs, undefined);
  // 未知 next_action 带回复文本的兜底分支同样补默认（否则回复发出后
  // 脱离等待节拍，客户不回就沉底）
  assert.equal(
    (
      parse({ next_action: "schedule_send", reply_segments: ["好的。"] }) as {
        waitMs?: number;
      }
    ).waitMs,
    DEFAULT_REPLY_WAIT_MS,
  );
});

test("reply：对象段归一化（vision 结构化段）", () => {
  const action = parse({
    next_action: "reply",
    reply_segments: [
      { type: "text", content: "甲" },
      { type: "text", text: "乙" },
      "丙",
    ],
  });
  assert.deepEqual(action.segments, ["甲", "乙", "丙"]);
});

test("reply：三个兜底键都缺 → 抛错（不静默发空回复）", () => {
  expectThrows(
    () => parse({ next_action: "reply" }),
    /requires reply_segments or reply_text/,
  );
});

test("ask_for_information：missing_fields 归一化", () => {
  const action = parse({
    next_action: "ask_for_information",
    reply_segments: ["什么型号？"],
    missing_fields: ["device_model", 42, "order_id"],
  });
  assert.equal(action.kind, "ask");
  assert.deepEqual((action as { requestedFacts: string[] }).requestedFacts, [
    "device_model",
    "order_id",
  ]);
});

test("retrieve_knowledge：query 必填、过程短讯截到 2 条", () => {
  const action = parse({
    next_action: "retrieve_knowledge",
    knowledge_query: "  导出失败 排查  ",
    reply_segments: ["稍等。", "我看下后台。", "马上。"],
  });
  assert.deepEqual(action, {
    kind: "use_tool",
    tool: "retrieve_knowledge",
    arguments: { query: "导出失败 排查" },
    segments: ["稍等。", "我看下后台。"],
    meta: { knowledgeQuery: "  导出失败 排查  " },
  });
  expectThrows(
    () => parse({ next_action: "retrieve_knowledge", knowledge_query: "   " }),
    /requires knowledge_query/,
  );
});

test("call_tool：name/arguments 提取，非字符串参数值丢弃", () => {
  const action = parse({
    next_action: "call_tool",
    tool: { name: "fetch_url", arguments: { url: "https://x", retry: 3 } },
  });
  assert.deepEqual(action, {
    kind: "use_tool",
    tool: "fetch_url",
    arguments: { url: "https://x" },
  });
  expectThrows(
    () => parse({ next_action: "call_tool", tool: { arguments: {} } }),
    /requires tool.name/,
  );
});

test("handoff：briefing snake/camel 兼容，segments 与 reasonCode", () => {
  const action = parse({
    next_action: "handoff",
    no_action_reason: "agent_recommended",
    handoff_briefing: {
      problem_summary: "导出失败",
      unresolved_items: ["日志"],
      suggested_first_reply: "您好",
    },
    reply_segments: ["转同事看一下，稍等。"],
  });
  assert.deepEqual(action, {
    kind: "handoff",
    reasonCode: "agent_recommended",
    briefing: {
      reasonCode: "handoff",
      problemSummary: "导出失败",
      unresolvedItems: ["日志"],
      suggestedFirstReply: "您好",
    },
    segments: ["转同事看一下，稍等。"],
    meta: {
      noActionReason: "agent_recommended",
      handoffBriefing: {
        problemSummary: "导出失败",
        unresolvedItems: ["日志"],
        suggestedFirstReply: "您好",
      },
    },
  });
  // 无 no_action_reason → 默认 "handoff"
  assert.equal(
    (
      parse({ next_action: "handoff", handoff_briefing: {} }) as {
        reasonCode: string;
      }
    ).reasonCode,
    "handoff",
  );
});

test("no_action：reasonCode 缺省与透传", () => {
  assert.deepEqual(parse({ next_action: "no_action" }), {
    kind: "no_action",
    reasonCode: "no_action",
  });
  assert.deepEqual(
    parse({ next_action: "no_action", no_action_reason: "waiting_for_user" }),
    {
      kind: "no_action",
      reasonCode: "waiting_for_user",
      meta: { noActionReason: "waiting_for_user" },
    },
  );
});

test("wait：clamp 边界与 fallback（来自 decision-protocol 单源）", () => {
  assert.equal(
    (parse({ next_action: "wait", wait_ms: 1 }) as { waitMs: number }).waitMs,
    WAIT_MS.min,
  );
  assert.equal(
    (parse({ next_action: "wait", wait_ms: 999_999_999 }) as { waitMs: number })
      .waitMs,
    WAIT_MS.max,
  );
  assert.equal(
    (parse({ next_action: "wait", wait_ms: "abc" }) as { waitMs: number })
      .waitMs,
    WAIT_MS.fallback,
  );
  assert.deepEqual(parse({ next_action: "wait", nudge_text: "试试了吗" }), {
    kind: "wait",
    waitMs: WAIT_MS.fallback,
    nudgeText: "试试了吗",
  });
});

test("end_session：closure_summary 与收尾话术", () => {
  assert.deepEqual(
    parse({
      next_action: "end_session",
      closure_summary: " 已解决 ",
      reply_segments: ["不客气。"],
    }),
    { kind: "end_session", closureSummary: "已解决", segments: ["不客气。"] },
  );
});

test("default 分支：未知 next_action 带可读回复 → 按 reply 发出；否则静默 no_action", () => {
  const asReply = parse({
    next_action: "schedule_send",
    reply_segments: ["好的。"],
    wait_ms: 60_000,
  });
  assert.deepEqual(asReply, {
    kind: "reply",
    segments: ["好的。"],
    waitMs: 60_000,
  });
  const suppressed = parse({ next_action: "wat" });
  assert.deepEqual(suppressed, {
    kind: "no_action",
    reasonCode: "unparsed_model_output",
  });
});

test("meta：requires_human / risk_level / briefing / knowledge_query / facts_card", () => {
  const action = parse({
    next_action: "no_action",
    no_action_reason: "policy_suppressed",
    requires_human: true,
    risk_level: "high",
    knowledge_query: "q",
    facts_card: { problem: "p" },
  }) as { meta?: Record<string, unknown> };
  assert.equal(action.meta?.requiresHuman, true);
  assert.equal(action.meta?.riskLevel, "high");
  assert.equal(action.meta?.knowledgeQuery, "q");
  assert.deepEqual(action.meta?.factsCard, { problem: "p" });
  assert.equal(action.meta?.noActionReason, "policy_suppressed");
  // 非法 risk_level 丢弃
  const clean = parse({ next_action: "no_action", risk_level: "urgent" }) as {
    meta?: Record<string, unknown>;
  };
  assert.equal(clean.meta?.riskLevel, undefined);
});

test("```json 围栏剥离", () => {
  const action = parseCustomerSupportResponse(
    '```json\n{"next_action":"reply","reply_segments":["好。"]}\n```',
  );
  assert.deepEqual(action, {
    kind: "reply",
    segments: ["好。"],
    waitMs: DEFAULT_REPLY_WAIT_MS,
  });
});

test("决策契约守卫：NEXT_ACTION_VALUES 每个动作 parser 都有分支（不落 unparsed）", () => {
  const expectedKind: Record<(typeof NEXT_ACTION_VALUES)[number], string> = {
    reply: "reply",
    ask_for_information: "ask",
    retrieve_knowledge: "use_tool",
    call_tool: "use_tool",
    handoff: "handoff",
    no_action: "no_action",
    wait: "wait",
    end_session: "end_session",
  };
  const minimal: Record<string, Record<string, unknown>> = {
    reply: { reply_segments: ["x"] },
    ask_for_information: {},
    retrieve_knowledge: { knowledge_query: "q" },
    call_tool: { tool: { name: "fetch_url" } },
    handoff: { handoff_briefing: {} },
    no_action: {},
    wait: {},
    end_session: {},
  };
  for (const action of NEXT_ACTION_VALUES) {
    const result = parse({ next_action: action, ...minimal[action] }) as {
      kind: string;
      reasonCode?: string;
    };
    assert.equal(
      result.kind,
      expectedKind[action],
      `next_action=${action} 应命中专属分支`,
    );
    assert.notEqual(result.reasonCode, "unparsed_model_output");
  }
});

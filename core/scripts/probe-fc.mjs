/**
 * FC（原生 function calling）探针 —— THINKING-PIPELINE-PLAN §6 前置验证：
 * 实测 DeepSeek 官方 API 对 tools 参数 + thinking 组合的真实行为，为
 * 「JSON 决策协议 → 原生 FC」迁移提供依据。不进应用代码。
 *
 * 六问：
 *  1. 现状 JSON 协议基线（对照组）
 *  2. tools + thinking enabled：是否回 tool_calls？reasoning_content 是否还在？
 *  3. 多轮回喂：tool 结果以 role:"tool" 回传能否收敛出最终文本
 *  4. tools + thinking disabled：延迟对照（FC 是否强制思考）
 *  5. tools + response_format json_object：组合是否冲突报错
 *  6. 并行多工具：单轮能否返回多个 tool_calls
 *
 * 用法：node scripts/probe-fc.mjs
 * 输出：控制台报告 + docs/model-probe-fc-result.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
function env(name) {
  const m = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : undefined;
}
const BASE_URL = (env("MODEL_BASE_URL") ?? "https://api.deepseek.com").replace(
  /\/$/,
  "",
);
const API_KEY = env("MODEL_API_KEY");
const MODEL = env("MODEL_NAME") ?? "deepseek-chat";

if (!API_KEY) {
  console.error("MODEL_API_KEY missing");
  process.exit(1);
}

/** 与生产决策契约同形的三个信息工具（沙箱只读） */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "retrieve_knowledge",
      description:
        "检索产品知识库，返回相关文档片段。回答故障/政策类问题前必须先检索。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "检索关键词，如错误码或故障现象",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_contact_profile",
      description: "查询当前客户的档案资料（购买记录、备注等）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "抓取一个网页的正文内容。",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
];

const SYSTEM = "你是产品客服代理。需要事实依据时先调用工具查证，再回答客户。";
const USER_FAULT = "软件打开就报错误码 12535，加密狗灯是亮的，怎么处理？";

async function rawCall(body, timeoutMs = 120_000) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const errBody = await response.text();
      return {
        ok: false,
        status: response.status,
        latencyMs,
        error: errBody.slice(0, 300),
      };
    }
    const payload = await response.json();
    const choice = payload.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const reasoning = message.reasoning_content ?? null;
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({
          name: call.function?.name ?? null,
          argumentsPreview: String(call.function?.arguments ?? "").slice(
            0,
            120,
          ),
        }))
      : [];
    return {
      ok: true,
      latencyMs,
      finishReason: choice.finish_reason ?? null,
      contentLength: (message.content ?? "").length,
      contentPreview: (message.content ?? "").slice(0, 160),
      hasReasoning: Boolean(reasoning && reasoning.trim()),
      reasoningLength: reasoning ? reasoning.length : 0,
      toolCalls,
      usage: payload.usage ?? null,
      rawMessage: message,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: String(error).slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarize(label, r) {
  if (!r.ok) {
    return {
      label,
      ok: false,
      status: r.status ?? null,
      latencyMs: r.latencyMs,
      error: (r.error ?? "").slice(0, 300),
    };
  }
  return {
    label,
    ok: true,
    latencyMs: r.latencyMs,
    finishReason: r.finishReason,
    contentLength: r.contentLength,
    contentPreview: r.contentPreview,
    hasReasoning: r.hasReasoning,
    reasoningLength: r.reasoningLength,
    toolCalls: r.toolCalls,
    usage: r.usage,
  };
}

const results = [];

// 1. 现状 JSON 协议基线（对照组）：模型在自造协议下选择"查证"的比例
results.push(
  summarize(
    "1-baseline-json-protocol",
    await rawCall({
      model: MODEL,
      stream: false,
      thinking: { type: "enabled" },
      response_format: { type: "json_object" },
      max_tokens: 16_384,
      messages: [
        {
          role: "system",
          content:
            "你是客服代理。只输出 JSON，next_action 可为 reply|retrieve_knowledge|call_tool。retrieve_knowledge 时提供 knowledge_query，系统会执行检索并把结果回喂给你。",
        },
        { role: "user", content: USER_FAULT },
      ],
    }),
  ),
);

// 2. tools + thinking enabled：FC 是否生效 + 思维链是否保留
const fcThinking = await rawCall({
  model: MODEL,
  stream: false,
  thinking: { type: "enabled" },
  max_tokens: 16_384,
  tools: TOOLS,
  tool_choice: "auto",
  messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: USER_FAULT },
  ],
});
results.push(summarize("2-fc+thinking-enabled", fcThinking));

// 3. 多轮回喂：tool 结果 role:"tool" 回传 → 收敛出最终文本
// （DeepSeek 要求 assistant 的每个 tool_call 都有对应 tool 消息，缺一 400）
if (fcThinking.ok && fcThinking.toolCalls.length > 0) {
  const toolMessages = fcThinking.rawMessage.tool_calls.map((call, index) => ({
    role: "tool",
    tool_call_id: call.id,
    content: JSON.stringify(
      index === 0
        ? {
            evidence: [
              {
                title: "错误码 12535 排查",
                content:
                  "12535 表示加密狗通讯异常：先重新插拔加密狗并换 USB 口，仍无效则重装加密狗驱动，再检查杀毒软件是否拦截。",
              },
            ],
          }
        : {
            profile: {
              lastOrder: "加密狗 pro x2（2026-08-12）",
              note: "老客户，三年保修",
            },
          },
    ),
  }));
  const roundTrip = await rawCall({
    model: MODEL,
    stream: false,
    thinking: { type: "enabled" },
    max_tokens: 16_384,
    tools: TOOLS,
    tool_choice: "auto",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER_FAULT },
      {
        role: "assistant",
        content: fcThinking.rawMessage.content ?? "",
        tool_calls: fcThinking.rawMessage.tool_calls,
      },
      ...toolMessages,
    ],
  });
  results.push(summarize("3-fc-tool-result-roundtrip", roundTrip));
} else {
  results.push({
    label: "3-fc-tool-result-roundtrip",
    ok: false,
    skipped: true,
    reason: "case-2 未返回 tool_calls，无法回喂",
  });
}

// 4. tools + thinking disabled：延迟对照（FC 是否强制思考）
results.push(
  summarize(
    "4-fc+thinking-disabled",
    await rawCall({
      model: MODEL,
      stream: false,
      thinking: { type: "disabled" },
      max_tokens: 16_384,
      tools: TOOLS,
      tool_choice: "auto",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER_FAULT },
      ],
    }),
  ),
);

// 5. tools + response_format json_object：组合是否冲突（迁移期可能需要并存；
//    json_object 模式要求提示词含 "json" 字样，system 提示已满足）
const JSON_FC_SYSTEM = `${SYSTEM} 最终回复必须是一个 json 对象。`;
results.push(
  summarize(
    "5-fc+json-object-conflict",
    await rawCall({
      model: MODEL,
      stream: false,
      thinking: { type: "enabled" },
      response_format: { type: "json_object" },
      max_tokens: 16_384,
      tools: TOOLS,
      tool_choice: "auto",
      messages: [
        { role: "system", content: JSON_FC_SYSTEM },
        { role: "user", content: USER_FAULT },
      ],
    }),
  ),
);

// 6. 并行多工具：提示同时需要两份资料，观察单轮多个 tool_calls
results.push(
  summarize(
    "6-fc-parallel-multi-tools",
    await rawCall({
      model: MODEL,
      stream: false,
      thinking: { type: "enabled" },
      max_tokens: 16_384,
      tools: TOOLS,
      tool_choice: "auto",
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content:
            "两件事：一，错误码 12535 怎么处理；二，帮我查下我的档案里上次买的什么型号。",
        },
      ],
    }),
  ),
);

const report = {
  probedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  model: MODEL,
  purpose: "原生 function calling + thinking 组合验证（FC 迁移前置探针）",
  results,
};
mkdirSync(new URL("../docs/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../docs/model-probe-fc-result.json", import.meta.url),
  JSON.stringify(
    report,
    (key, value) => (key === "rawMessage" ? undefined : value),
    2,
  ),
);

for (const r of results) {
  if (r.skipped) {
    console.log(`${r.label.padEnd(34)} SKIP ${r.reason ?? ""}`);
    continue;
  }
  if (!r.ok) {
    console.log(
      `${r.label.padEnd(34)} ERR ${r.status ?? ""} ${String(r.latencyMs).padStart(6)}ms ${(r.error ?? "").slice(0, 90)}`,
    );
    continue;
  }
  const tc =
    r.toolCalls.length > 0
      ? `tools=[${r.toolCalls.map((c) => c.name).join(",")}]`
      : "tools=none";
  console.log(
    `${r.label.padEnd(34)} ok ${String(r.latencyMs).padStart(6)}ms finish=${String(r.finishReason).padEnd(10)} ${tc.padEnd(34)} reasoning=${r.hasReasoning ? `YES(${r.reasoningLength})` : "no "} out=${r.usage?.completion_tokens ?? "?"}tok`,
  );
}

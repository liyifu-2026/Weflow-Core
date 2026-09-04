/**
 * B0 模型探针（THINKING-PIPELINE-PLAN）：
 * 实测 DeepSeek 官方 API 对思考控制/max_tokens 上限的真实行为，
 * 为 openai-compatible-client 的参数形态提供依据。不进应用代码。
 *
 * 用法：node scripts/probe-model.mjs
 * 输出：控制台报告 + docs/model-probe-result.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
function env(name) {
  const m = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : undefined;
}
const BASE_URL = (env("MODEL_BASE_URL") ?? "https://api.deepseek.com").replace(/\/$/, "");
const API_KEY = env("MODEL_API_KEY");
const MODEL = env("MODEL_NAME") ?? "deepseek-chat";

if (!API_KEY) {
  console.error("MODEL_API_KEY missing");
  process.exit(1);
}

/** 简单决策式提示：贴近 Agent 决策调用形态（JSON 输出 + 小场景） */
const messages = [
  {
    role: "system",
    content:
      '你是会话代理。只输出 JSON：{"next_action":"reply","reply_text":"..."}。回复需自然、简洁。',
  },
  {
    role: "user",
    content: "我上周买的耳机左耳没声音了，才用了三天，怎么办？",
  },
];

async function call(label, body, timeoutMs = 120_000) {
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
        label,
        ok: false,
        status: response.status,
        latencyMs,
        error: errBody.slice(0, 300),
      };
    }
    const payload = await response.json();
    const choice = payload.choices?.[0] ?? {};
    const reasoning = choice.message?.reasoning_content ?? null;
    return {
      label,
      ok: true,
      latencyMs,
      finishReason: choice.finish_reason ?? null,
      contentLength: (choice.message?.content ?? "").length,
      contentPreview: (choice.message?.content ?? "").slice(0, 120),
      hasReasoning: Boolean(reasoning && reasoning.trim()),
      reasoningLength: reasoning ? reasoning.length : 0,
      usage: payload.usage ?? null,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      latencyMs: Date.now() - started,
      error: String(error).slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];

// 1. 现状基线：应用当前发出的形态（GLM thinking + JSON mode + 8000）
results.push(
  await call("baseline-current-glm-thinking+json+8k", {
    model: MODEL,
    messages,
    stream: false,
    thinking: { type: "enabled" },
    response_format: { type: "json_object" },
    max_tokens: 8_000,
  }),
);

// 2. 无任何思考参数（观察默认行为）
results.push(
  await call("no-thinking-param+json+8k", {
    model: MODEL,
    messages,
    stream: false,
    response_format: { type: "json_object" },
    max_tokens: 8_000,
  }),
);

// 3. GLM 形态 disabled（验证 disabled 是否被尊重）
results.push(
  await call("glm-thinking-disabled+json+8k", {
    model: MODEL,
    messages,
    stream: false,
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
    max_tokens: 8_000,
  }),
);

// 4. 常见替代形态：enable_thinking（部分 OpenAI 兼容实现采用）
results.push(
  await call("enable_thinking+json+8k", {
    model: MODEL,
    messages,
    stream: false,
    enable_thinking: true,
    response_format: { type: "json_object" },
    max_tokens: 8_000,
  }),
);

// 5. max_tokens 上限探测：16384（不接受会 4xx 或按上限截断）
results.push(
  await call("max_tokens-16384", {
    model: MODEL,
    messages,
    stream: false,
    max_tokens: 16_384,
  }),
);

// 6. 长思考诱发（复杂场景 + 8k 预算）：观察思考对延迟/截断的真实影响
results.push(
  await call("complex-scenario-8k", {
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          '你是会话代理。只输出 JSON：{"next_action":"reply"|"handoff","reply_text":"...","reasoning_brief":"..."}。需要综合判断时先仔细思考再作答。',
      },
      {
        role: "user",
        content:
          "我是你们的老客户了，这已经是第三次投诉了：第一次是发货慢，第二次是包装破了，这次商品直接是坏的。你们再这样我就去投诉到平台，并且要求全额退款加赔偿。你现在告诉我到底怎么解决？",
      },
    ],
    stream: false,
    thinking: { type: "enabled" },
    max_tokens: 8_000,
  }),
);

const report = {
  probedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  model: MODEL,
  results,
};
mkdirSync(new URL("../docs/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../docs/model-probe-result.json", import.meta.url),
  JSON.stringify(report, null, 2),
);

for (const r of results) {
  const line = r.ok
    ? `${r.label.padEnd(38)} ok ${String(r.latencyMs).padStart(6)}ms finish=${String(r.finishReason).padEnd(10)} content=${String(r.contentLength).padStart(5)} reasoning=${r.hasReasoning ? `YES(${r.reasoningLength})` : "no "} out=${r.usage?.completion_tokens ?? "?"}tok`
    : `${r.label.padEnd(38)} ERR ${r.status ?? ""} ${String(r.latencyMs).padStart(6)}ms ${(r.error ?? "").slice(0, 80)}`;
  console.log(line);
}

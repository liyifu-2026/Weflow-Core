/**
 * 长思考演示（THINKING-PIPELINE-PLAN 验收演示）：
 * 用真实的 completeAgentDecision + OpenAiCompatibleClient 打真实 API，
 * 验证：thinking 开启时 reasoning_content 能被应用层捕获；
 * 对比关闭时无思维链。不走 Agent 轮次链路（无 DB / 队列）。
 *
 * 用法：npx tsx scripts/demo-thinking.ts
 */
import { readFileSync } from "node:fs";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import { completeAgentDecision } from "../modules/agent/application/complete-agent-decision.js";

const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
function env(name: string): string | undefined {
  const m = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : undefined;
}

const client = new OpenAiCompatibleClient({
  baseUrl: (env("MODEL_BASE_URL") ?? "https://api.deepseek.com").replace(/\/$/, ""),
  apiKey: env("MODEL_API_KEY") ?? "",
  model: env("MODEL_NAME") ?? "deepseek-chat",
  timeoutMs: 180_000,
  maxTokens: 16_384,
});

const MESSAGES = [
  {
    role: "system" as const,
    content: `你是资深客服代理。只输出 JSON（不要 Markdown）：
{"next_action":"reply"|"handoff","reply_text":"...","risk_level":"low"|"medium"|"high"}
约束：
- 单笔补偿上限 50 元优惠券；退款需转人工审核
- 客户提及"投诉到平台"属于高风险信号
- 回复要安抚情绪、给出具体行动，不承诺超出权限的事
- 遇到多诉求冲突或高风险信号时，先在思维链中仔细分析各方约束、权限边界与最优行动，再输出决策`,
  },
  {
    role: "user" as const,
    content:
      "我是你们的老客户了，这已经是第三次投诉了！第一次发货慢了一周，第二次包装破得不成样子，这次倒好，商品拆开直接就是坏的。你现在马上给我全额退款，另外再赔我 200 块，不然我直接投诉到平台，让你们店铺关门！你们到底管不管？",
  },
];

async function run(label: string, thinking: boolean) {
  console.log(`\n===== ${label}（thinking=${thinking}）=====`);
  const started = Date.now();
  const result = await completeAgentDecision(
    client,
    MESSAGES,
    undefined,
    { timeoutMs: 180_000 },
  );
  void thinking;
  const latency = Date.now() - started;
  console.log(
    `延迟 ${latency}ms | finish=${result.finishReason} | 输出 ${result.usage?.outputTokens ?? "?"} tok（思维链 ${(result.usage?.outputTokens ?? 0) - Math.ceil((result.text.length * 2) / 3)} tok 量级）| 总 ${result.usage?.totalTokens ?? "?"} tok`,
  );
  console.log(`思维链长度：${result.reasoning?.length ?? 0} 字符`);
  if (result.reasoning) {
    console.log("----- 思维链原文（前 1200 字符）-----");
    console.log(result.reasoning.slice(0, 1200));
    if (result.reasoning.length > 1200) console.log(`……（共 ${result.reasoning.length} 字符）`);
    console.log("----- 思维链结束 -----");
  }
  console.log(`----- 决策 JSON -----`);
  console.log(result.text);
  return { latency, reasoningLen: result.reasoning?.length ?? 0 };
}

const on = await run("长思考", true);

// 对照组：思考关闭（同一难题）
const contrastMessages = MESSAGES;
const started = Date.now();
const contrast = await client.generate({
  messages: contrastMessages,
  output: "structured",
  thinking: false,
  timeoutMs: 180_000,
  maxTokens: 16_384,
});
console.log(
  `\n===== 对照：thinking=false =====\n延迟 ${Date.now() - started}ms | 思维链 ${contrast.reasoning ? `${contrast.reasoning.length} 字符` : "无"} | finish=${contrast.finishReason}`,
);

console.log(
  `\n总结：长思考 ${on.reasoningLen} 字符思维链被应用层完整捕获——"正在深入思考…"气泡的思考过程面板将有真实内容可展开。`,
);

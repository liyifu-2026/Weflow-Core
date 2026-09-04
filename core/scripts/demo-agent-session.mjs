/**
 * 多轮会话演练（THINKING-PIPELINE-PLAN 演示扩展）：
 * 模拟一个真实形态的客服会话——多段对话、agent 自主决定调用工具
 * （客户档案 / 知识库检索）、每步带思维链、最终以决策 JSON 收口
 * （含定时发送）。不走 Agent 轮次链路（无 DB / 队列），工具与数据为假。
 *
 * 用法：node scripts/demo-agent-session.mjs
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
function env(name) {
  const m = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : undefined;
}
const BASE_URL = (env("MODEL_BASE_URL") ?? "https://api.deepseek.com").replace(/\/$/, "");
const API_KEY = env("MODEL_API_KEY");
const MODEL = env("MODEL_NAME") ?? "deepseek-chat";

// ---------- 假数据（贴合场景的工具结果） ----------
const CONTACT = {
  name: "王先生",
  memberSince: "2023-06",
  tier: "金牌会员",
  totalSpent: "¥8,600",
  complaintHistory: "历史投诉 2 次（2026-03 发货延迟已安抚；2026-07-20 包装破损，补偿 12 元运费券）",
  notes: "对物流时效敏感，情绪恢复快，认可主动补偿",
};

const KNOWLEDGE = {
  "质量问题 退换货 政策": "【质量问题退换】签收后 15 天内凭照片凭证可申请质量退货退款，往返运费由商家承担；超 15 天进入保修流程。",
  "补偿 权限 优惠券 上限": "【补偿权限】一线客服单笔补偿上限：50 元优惠券；全额退款需售后专员审核（24h 内出结果）；现金赔偿需主管审批。",
  "运费 承担 运费险": "【运费规则】质量问题退换运费由商家承担（含客户先行垫付的返程运费，凭截图补偿）；非质量问题运费客户自理。",
  "平台投诉 升级 时限": "【平台投诉红线】客户提及'投诉到平台'：须 24 小时内完成响应并升级主管挂关注件，避免平台介入考核扣分。",
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "query_contact_profile",
      description: "查询客户档案：会员等级、累计消费、历史投诉与补偿记录。调用一次即返回当前客户王先生的完整档案。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "retrieve_knowledge",
      description: "检索客服知识库。query 用关键词，如：质量问题 退换货 政策 / 补偿 权限 上限 / 平台投诉 升级 时限 / 运费 承担",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "检索关键词" } },
        required: ["query"],
      },
    },
  },
];

function runTool(name, args) {
  if (name === "query_contact_profile") {
    return JSON.stringify({ ...CONTACT, reminder: "历史补偿仅 12 元运费券，本次为第三次投诉，请酌情提高安抚力度" });
  }
  if (name === "retrieve_knowledge") {
    const q = String(args.query ?? "");
    const hit = Object.keys(KNOWLEDGE).find((k) => k.split(" ").some((word) => q.includes(word)));
    return JSON.stringify({
      found: Boolean(hit),
      content: hit ? KNOWLEDGE[hit] : "未命中，可换关键词重试",
      matched: hit ?? null,
    });
  }
  return JSON.stringify({ error: "unknown tool" });
}

const SYSTEM = `你是资深客服代理"小微"，正在微信上接待客户。你可以调用工具查档案、查知识库；信息足够后输出最终决策。
最终决策只输出 JSON（不要 Markdown）：
{"next_action":"reply"|"handoff","reply_text":"...","risk_level":"low"|"medium"|"high","schedule_message":"可选，到点自动发送的回访话术","scheduled_send_at":"可选，ISO 8601"}
约束：
- 一线补偿权限上限 50 元优惠券；全额退款需转人工审核；现金赔偿需主管审批
- 客户提及"投诉到平台"= 高风险，须承诺 24 小时内响应并升级
- 回复自然、有同理心、给具体行动；不承诺超权限的事
- 高难度场景先在心里把各方约束和权限边界想清楚，再决定说什么`

const TURNS = [
  "我第三次投诉了！商品拆开是坏的，马上全额退款，再赔我 200，不然我直接投诉到平台！",
  "照片我拍好了发你了。另外我特意查了，质量问题退货运费应该是你们出吧？上一次我退运费还自己贴了 12 块钱！",
  "行，那退款和 12 块运费到底什么时候能到账？我今天必须得到一个准话。",
  "行吧，那就这么说定了。对了，明天上午十点再提醒我一下查收退款，别到时候又没人理我。",
];

async function callModel(messages, allowTools) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  const started = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: false,
        thinking: { type: "enabled" },
        max_tokens: 16_384,
        ...(allowTools ? { tools: TOOLS } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const payload = await response.json();
    return { latency: Date.now() - started, message: payload.choices[0].message, usage: payload.usage };
  } finally {
    clearTimeout(timer);
  }
}

function clip(text, n) {
  const t = String(text ?? "").trim();
  return t.length <= n ? t : `${t.slice(0, n)}……`;
}

// ---------- 会话主循环 ----------
const history = [
  { role: "system", content: SYSTEM },
];
const customerQueue = [...TURNS];

(async () => {
  let turnNo = 0;
  for (const customerMessage of customerQueue) {
    turnNo += 1;
    console.log(`\n${"═".repeat(56)}`);
    console.log(`【第 ${turnNo} 轮】`);
    console.log(`👤 客户：${customerMessage}`);
    history.push({ role: "user", content: customerMessage });

    let toolRounds = 0;
    // ReAct 内循环：模型自主决定调工具还是给最终决策
    for (let step = 0; step < 5; step += 1) {
      const allowTools = toolRounds < 3;
      const { latency, message, usage } = await callModel(history, allowTools);
      const reasoning = message.reasoning_content ?? "";
      const reasoningNote = reasoning
        ? `🧠 思考（${reasoning.length} 字）：${clip(reasoning, 320)}`
        : "🧠 思考：（本步无展开思维链）";
      console.log(`   ${reasoningNote}  [${latency}ms, ${usage?.completion_tokens ?? "?"}tok]`);

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length > 0 && allowTools) {
        history.push(message);
        for (const call of toolCalls) {
          const args = JSON.parse(call.function.arguments ?? "{}");
          console.log(`🔧 调用 ${call.function.name}(${JSON.stringify(args)})`);
          const result = runTool(call.function.name, args);
          console.log(`   ↳ ${clip(result, 220)}`);
          history.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        toolRounds += 1;
        continue;
      }

      // 最终决策（JSON）
      let decision;
      try {
        decision = JSON.parse(message.content);
      } catch {
        console.log(`💬 原始输出（JSON 解析失败）：${clip(message.content, 300)}`);
        history.push({ role: "assistant", content: message.content });
        break;
      }
      console.log(`💬 决策：next_action=${decision.next_action}  risk=${decision.risk_level ?? "-"}`);
      if (decision.reply_text) console.log(`   回复客户：${decision.reply_text}`);
      if (decision.schedule_message) {
        console.log(`⏰ 已排定定时消息："${decision.schedule_message}" @ ${decision.scheduled_send_at}`);
      }
      history.push({ role: "assistant", content: message.content });
      break;
    }
  }
  console.log(`\n${"═".repeat(56)}`);
  console.log("会话结束。以上思维链 / 工具调用 / 定时发送均为演示输出，未经过真实 Agent 链路。");
})().catch((error) => {
  console.error("ERR", error);
  process.exit(1);
});

/**
 * V9 故障咨询会话演练（多轮 + 工具 + 长思考）：
 * 场景 = 客户先问"v9 软件是什么"，再报"v9 打不开"，按指引排查仍失败 → 升级。
 * 知识库为 V9 产品介绍 + 启动故障排查资料（假数据，贴近真实客服知识库）。
 * 不经过真实 Agent 链路（无 DB / 队列）；工具与知识库为假，模型与思维链为真。
 *
 * 用法：node scripts/demo-v9-troubleshoot.mjs
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

// ---------- 假数据 ----------
const CONTACT = {
  name: "李工",
  role: "验收测试客户",
  contactHistory: "首次咨询；此前参与过 V9 内测反馈",
  notes: "技术背景一般，需要通俗解释，避免堆术语",
};

const KNOWLEDGE = {
  "v9 是什么 产品介绍": "【V9 产品介绍】Weflow V9 是面向客服团队的智能客服系统（当前正式版本），提供：微信多账号接入、AI 自动回复、人工接管、知识库、会话分析等能力。V9 相比 V8 的核心升级：AI 员工可按客户绑定专属人设、支持定时回访、故障自诊断。",
  "v9 打不开 启动 失败 排查": "【V9 启动故障排查】按顺序执行：1) 检查任务管理器是否残留 V9 进程，有则结束进程后重新启动；2) 右键快捷方式选'以管理员身份运行'；3) 确认操作系统为 Win10 及以上；4) 检查是否安装 Visual C++ 2015-2022 运行库（缺失会报缺 DLL）；5) 若仍失败，到安装目录 logs/ 下把最新日志发给客服。",
  "v9 闪退 缺少 组件 报错": "【V9 缺组件报错】报错含 'VCRUNTIME140.dll' 或 'MSVCP140.dll'：安装 Microsoft Visual C++ 2015-2022 Redistributable (x64) 后重启电脑即可。报错含 'Node' 或 'Electron' 字样：属于安装包损坏，需卸载后到官网重新下载最新安装包。",
  "v9 日志 位置 发日志": "【日志位置】默认安装目录 C:\\Program Files\\WeflowV9\\logs\\，文件名 v9-YYYYMMDD.log；绿色版在解压目录 logs\\ 下。发给客服时只需最新一天的日志文件。",
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "query_contact_profile",
      description: "查询当前客户档案（身份、历史咨询记录、备注）。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "retrieve_knowledge",
      description:
        "检索客服知识库。query 用关键词组合，如：v9 是什么 产品介绍 / v9 打不开 启动 失败 排查 / v9 闪退 缺少 组件 报错 / v9 日志 位置",
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
    return JSON.stringify(CONTACT);
  }
  if (name === "retrieve_knowledge") {
    const q = String(args.query ?? "");
    const hit = Object.keys(KNOWLEDGE).find((k) =>
      k.split(" ").some((word) => q.includes(word)),
    );
    return JSON.stringify({
      found: Boolean(hit),
      content: hit ? KNOWLEDGE[hit] : "未命中，建议更换关键词或转人工",
      matched: hit ?? null,
    });
  }
  return JSON.stringify({ error: "unknown tool" });
}

const SYSTEM = `你是智能客服"小V"，通过微信接待客户。你可以调用工具查客户档案、检索知识库；信息足够后输出最终决策。
最终决策只输出 JSON（不要 Markdown）：
{"next_action":"reply"|"ask_for_information"|"handoff","reply_text":"...","risk_level":"low"|"medium"|"high"}
约束：
- next_action=ask_for_information 表示需要客户补充信息才能继续，回复里明确说出需要什么
- 涉及安装包损坏、多次排查无效等无法远程解决的问题，选 handoff 转人工，回复里说明已升级
- 回复通俗、分步骤、有同理心；一次不要抛超过 4 个步骤，避免客户消化不了
- 高难度场景先在心里梳理已知信息、缺失信息与排查路径，再决定说什么`

const TURNS = [
  "麻烦问一下，你们说的这个 v9 软件到底是什么东西啊？我跟你们聊了半天工单，都没搞明白 v9 是啥。",
  "哦哦原来如此。对了正事：我这边 v9 打不开了，双击图标一点反应都没有，怎么回事？",
  "任务管理器里没有残留进程，也用管理员身份跑了，还是打不开，一直弹窗说缺什么 dll 组件……",
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
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const payload = await response.json();
    return { latency: Date.now() - started, message: payload.choices[0].message };
  } finally {
    clearTimeout(timer);
  }
}

function clip(text, n) {
  const t = String(text ?? "").trim();
  return t.length <= n ? t : `${t.slice(0, n)}……`;
}

const history = [{ role: "system", content: SYSTEM }];

(async () => {
  let turnNo = 0;
  for (const customerMessage of TURNS) {
    turnNo += 1;
    console.log(`\n${"═".repeat(56)}`);
    console.log(`【第 ${turnNo} 轮】`);
    console.log(`👤 客户：${customerMessage}`);
    history.push({ role: "user", content: customerMessage });

    let toolRounds = 0;
    for (let step = 0; step < 5; step += 1) {
      const allowTools = toolRounds < 3;
      const { latency, message } = await callModel(history, allowTools);
      const reasoning = message.reasoning_content ?? "";
      console.log(
        `   🧠 思考（${reasoning.length} 字）：${reasoning ? clip(reasoning, 360) : "（本步无展开）"}  [${latency}ms]`,
      );

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length > 0 && allowTools) {
        history.push(message);
        for (const call of toolCalls) {
          const args = JSON.parse(call.function.arguments ?? "{}");
          console.log(`🔧 调用 ${call.function.name}(${JSON.stringify(args)})`);
          const result = runTool(call.function.name, args);
          console.log(`   ↳ ${clip(result, 240)}`);
          history.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        toolRounds += 1;
        continue;
      }

      let decision;
      try {
        decision = JSON.parse(message.content);
      } catch {
        console.log(`💬 原始输出（JSON 解析失败，真实链路会校验兜底）：${clip(message.content, 300)}`);
        history.push({ role: "assistant", content: message.content });
        break;
      }
      console.log(`💬 决策：next_action=${decision.next_action}  risk=${decision.risk_level ?? "-"}`);
      if (decision.reply_text) console.log(`   回复客户：${decision.reply_text}`);
      history.push({ role: "assistant", content: message.content });
      break;
    }
  }
  console.log(`\n${"═".repeat(56)}`);
  console.log("演练结束。思维链与工具调用为真实模型输出；知识库与客户档案为演示假数据。");
})().catch((error) => {
  console.error("ERR", error);
  process.exit(1);
});

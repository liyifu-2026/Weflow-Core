/**
 * 决策模型（decision-model-preview / System One）连通性冒烟探针。
 *
 * 用法（key 走环境变量，绝不写入任何文件）：
 *   DASHSCOPE_API_KEY=sk-xxx node scripts/probe-decision-model.mjs [baseUrl]
 *
 * 不带 baseUrl 参数时按官方文档候选域依次尝试：
 *   1. https://dashscope.aliyuncs.com            （兼容模式通用域）
 *   2. https://default.cn-beijing.maas.aliyuncs.com（文档 workspace 域的缺省形态）
 *
 * 输出：每个候选域的 HTTP 状态 / answers / usage / latency；全失败退出码 1。
 * 密钥不落盘、不进日志（错误输出只含状态码与响应片段前 300 字）。
 */
const key = process.env.DASHSCOPE_API_KEY;
if (!key || key.length < 8) {
  console.error("缺少 DASHSCOPE_API_KEY 环境变量");
  process.exit(1);
}
const model = process.env.DECISION_MODEL ?? "decision-model-preview";
const candidates = process.argv[2]
  ? [process.argv[2]]
  : [
      "https://dashscope.aliyuncs.com",
      "https://default.cn-beijing.maas.aliyuncs.com",
    ];
const body = JSON.stringify({
  model,
  state: "您好，我上周买的空气炸锅加热管不工作了，能帮我处理一下吗？",
  questions: {
    q_need_human: { type: "noul", instructions: "是否需要转人工处理" },
  },
});

let anyOk = false;
for (const base of candidates) {
  const url = `${base.replace(/\/+$/, "")}/compatible-mode/v1/systemone`;
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const elapsed = Date.now() - startedAt;
    const text = await response.text();
    if (!response.ok) {
      console.log(`[${base}] HTTP ${response.status} (${elapsed}ms)`);
      console.log(`  ${text.slice(0, 300)}`);
      continue;
    }
    const parsed = JSON.parse(text);
    console.log(`[${base}] HTTP 200 (${elapsed}ms, 服务端 latency_ms=${parsed.latency_ms ?? "?"})`);
    console.log(`  model: ${parsed.model ?? "?"}`);
    console.log(`  answers: ${JSON.stringify(parsed.answers)}`);
    console.log(`  usage: ${JSON.stringify(parsed.usage ?? {})}`);
    anyOk = true;
  } catch (error) {
    console.log(`[${base}] 请求失败：${error?.name ?? "?"} ${String(error?.message ?? error).slice(0, 200)}`);
  }
}
process.exit(anyOk ? 0 : 1);

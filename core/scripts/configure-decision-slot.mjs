/**
 * 决策模型一键接线：探测 → 注册端点 → 绑 decision 槽位 → 开影子模式。
 *
 * 用法（key/工作空间走环境变量，绝不写入任何文件或 git）：
 *   DASHSCOPE_API_KEY=sk-xxx DECISION_WORKSPACE_ID=<百炼业务空间ID> \
 *     node scripts/configure-decision-slot.mjs
 *
 * 前置：core/.env 有 DATABASE_URL（Postgres）。脚本动作：
 *   1. 用真实 key 对 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com
 *      发一次最小 systemone 判定，非 200 直接退出（不动库）；
 *   2. UPSERT operations.model_registry（model_id=bailian-decision-model，
 *      protocol=system_one，capabilities=["decision"]）；
 *   3. UPSERT operations.runtime_settings 的 model_slot_decision 绑定；
 *   4. solution.extension_settings（scope=weflow.customer-support,
 *      key=support-pipeline）的 settings_json.decision.shadowEnabled 置 true
 *      ——仅当该键缺失时（已是 true/false 均尊重现状，不覆盖）。
 * 密钥只写入 DB 的 api_key 列（与既有端点同法，读取视图永不回显）。
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const key = process.env.DASHSCOPE_API_KEY;
const workspaceId = process.env.DECISION_WORKSPACE_ID;
if (!key || !workspaceId) {
  console.error(
    "缺少 DASHSCOPE_API_KEY 或 DECISION_WORKSPACE_ID 环境变量（百炼控制台首页可查业务空间 ID）",
  );
  process.exit(1);
}
const baseUrl = `https://${workspaceId}.cn-beijing.maas.aliyuncs.com`;
const modelId = "bailian-decision-model";
const model = process.env.DECISION_MODEL ?? "decision-model-preview";

// ── 1. 探测：非 200 不动库 ────────────────────────────────────────────
const startedAt = Date.now();
const probeResponse = await fetch(`${baseUrl}/compatible-mode/v1/systemone`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    state: "冒烟：客户询问发票怎么开。",
    questions: { q_need_human: { type: "noul", instructions: "是否需要转人工" } },
  }),
  signal: AbortSignal.timeout(15_000),
});
const probeText = await probeResponse.text();
if (!probeResponse.ok) {
  console.error(`探测失败 HTTP ${probeResponse.status}：${probeText.slice(0, 300)}`);
  process.exit(1);
}
const probe = JSON.parse(probeText);
console.log(
  `探测 OK：latency_ms=${probe.latency_ms ?? "?"} answers=${JSON.stringify(probe.answers)} model=${probe.model ?? "?"}`,
);

// ── 2-4. 写库 ─────────────────────────────────────────────────────────
const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
const databaseUrl = envText
  .split(/\r?\n/)
  .find((line) => line.startsWith("DATABASE_URL="))
  ?.slice("DATABASE_URL=".length)
  .trim();
if (!databaseUrl) {
  console.error("core/.env 缺少 DATABASE_URL");
  process.exit(1);
}
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(
    `INSERT INTO operations.model_registry
       (model_id, display_name, base_url, api_key, capabilities, protocol, timeout_ms, enabled)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'system_one', 5000, true)
     ON CONFLICT (model_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       base_url = EXCLUDED.base_url,
       api_key = COALESCE(nullif($4, ''), operations.model_registry.api_key),
       capabilities = EXCLUDED.capabilities,
       protocol = EXCLUDED.protocol,
       enabled = true`,
    [
      modelId,
      model,
      baseUrl,
      key,
      JSON.stringify(["decision"]),
    ],
  );
  await client.query(
    `INSERT INTO operations.runtime_settings (key, value, updated_by)
     VALUES ('model_slot_decision', $1, 'decision-model-probe')
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [modelId],
  );
  const { rows } = await client.query(
    `SELECT settings_json FROM solution.extension_settings
     WHERE scope = 'weflow.customer-support' AND key = 'support-pipeline'`,
  );
  if (rows.length === 0) {
    console.log("未找到 support-pipeline 扩展设置（BFF 尚未注册过？），跳过影子开关");
  } else {
    const settings = rows[0].settings_json;
    const current = settings.decision?.shadowEnabled;
    if (current === undefined) {
      // decision 键缺失（BFF 新种子未跑过）或开关未定义 → 补齐默认配置并开影子。
      // 问题集/阈值与 BFF 种子同源（业务话术，改话术去 BFF 种子改）。
      settings.decision = {
        ...(settings.decision ?? {}),
        shadowEnabled: true,
        triageEnabled: false,
        worthReplyEnabled: false,
        timeoutMs: 500,
        thresholds: {
          humanProbability: 0.85,
          humanConfidence: 0.6,
          simpleProbability: 0.8,
          noReplyProbability: 0.9,
        },
        questions: settings.decision?.questions ?? {
          q_need_human: {
            type: "noul",
            instructions:
              "判断该客户最新消息是否需要转给人工客服处理。需要转人工的情形：客户情绪激烈或明确表达不满、涉及退款赔偿等敏感诉求、问题明显超出自动客服能力、客户明确要求人工服务。普通咨询、寒暄、简单确认都不需要转人工。",
          },
          q_tier: {
            type: "choice",
            instructions:
              "判断该客户消息适合哪种处理档位。simple=寒暄问候、简单确认或纯情绪安抚，不需要业务知识即可得体回复；standard=涉及产品、订单、售后等需要业务知识的实质问题。",
            criteria: {
              simple: "寒暄/问候/简单确认/纯情绪安抚",
              standard: "需要业务知识的实质问题",
              other: "无法判断",
            },
          },
          q_worth_reply: {
            type: "noul",
            instructions:
              "判断该消息是否需要客服作出回应。需要回应的情形：包含问题、诉求、情绪表达或对客服上条消息的实质反馈。不需要回应的情形：纯表情、语气词（如\"哦\"\"哈哈\"）、无实义的闲聊碎片。拿不准时视为需要回应。",
          },
        },
      };
      await client.query(
        `UPDATE solution.extension_settings
         SET settings_json = $1::jsonb, updated_by = 'decision-model-probe', updated_at = now()
         WHERE scope = 'weflow.customer-support' AND key = 'support-pipeline'`,
        [JSON.stringify(settings)],
      );
      console.log("decision 配置补齐，shadowEnabled → true（影子模式，30s 内热加载）");
    } else {
      console.log(
        `decision.shadowEnabled 现状为 ${JSON.stringify(current)}，尊重现状不覆盖`,
      );
    }
  }
  console.log(
    `完成：端点 ${modelId} 已注册（密钥已入库不回显）、decision 槽位已绑定、热加载 15s 内生效。`,
  );
} finally {
  await client.end();
}

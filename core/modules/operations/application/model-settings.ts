/**
 * 平台大模型设置（Operator Control Plane · 引导配置）
 *
 * 模型选择的唯一事实源是模型网关（model-gateway：槽位 + 注册表）；
 * 本模块只承载 text/triage/fast 三组的启动引导值（DB model_* / triage_* /
 * fast_* 键 → env 默认），供 agent-worker 在槽位未绑定时回落使用。
 * 视觉/语音模型不在此处：识图与 ASR 的执行端直接解析 vision/asr 槽位
 * （ingestion-worker），env 仅作种子。
 *
 * 存储：operations.runtime_settings 表（DB 值覆盖 env 默认；
 * API key 属于 secret，读取时永不回显）。
 * - 消费方（agent-worker）经 model-settings-hot 热加载，指纹变化即时生效。
 * - 写路径已收敛到模型网关（model-gateway：注册表 + 槽位绑定），本模块只读。
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

/** 环境默认值（config 传入，作为 DB 缺失时的 fallback） */
export type ModelSettingsDefaults = {
  textModel: { name: string; baseUrl: string; apiKey?: string };
  triageModel?: { name: string; baseUrl: string; apiKey?: string };
  fastModel?: { name: string; baseUrl: string; apiKey?: string };
};

type FieldKeys = {
  name: string;
  baseUrl: string;
  apiKey: string;
};

const TEXT_KEYS: FieldKeys = {
  name: "model_name",
  baseUrl: "model_base_url",
  apiKey: "model_api_key",
};

const TRIAGE_KEYS: FieldKeys = {
  name: "triage_model",
  baseUrl: "triage_base_url",
  apiKey: "triage_api_key",
};

const FAST_KEYS: FieldKeys = {
  name: "fast_model",
  baseUrl: "fast_base_url",
  apiKey: "fast_api_key",
};

async function readRow(
  db: NodePgDatabase<typeof schema>,
  key: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ value: schema.runtimeSettings.value })
    .from(schema.runtimeSettings)
    .where(eq(schema.runtimeSettings.key, key))
    .limit(1);
  return rows[0]?.value;
}

/** 运行时完整配置（服务端消费方使用：含 apiKey，不得对外返回） */
export type ModelSettingsRuntime = {
  textModel: { name: string; baseUrl: string; apiKey?: string };
  triageModel?: { name: string; baseUrl: string; apiKey?: string };
  fastModel?: { name: string; baseUrl: string; apiKey?: string };
  /**
   * 模型网关（注册表 + 槽位绑定）内容指纹：任一注册表行或槽位绑定变化
   * 都会改变指纹，消费方据此重建故障转移链等派生客户端（实现「注册表
   * 保存后即时生效，无需重启 worker」）。apiKey 参与指纹（换 key 需重建
   * 客户端），指纹本身不落日志。读取失败为 "unreadable"，下轮轮询重试。
   */
  modelGatewayFingerprint: string;
};

/**
 * 计算模型网关内容指纹：注册表全部行（含 apiKey，密钥变化必须重建
 * 客户端）+ 槽位绑定。按 modelId 排序保证顺序无关；JSON 序列化后经
 * FNV-1a 压成短指纹，仅用于变化检测，不承担安全职责。
 */
async function computeModelGatewayFingerprint(
  db: NodePgDatabase<typeof schema>,
): Promise<string> {
  try {
    const [registryRows, slotRows] = await Promise.all([
      db.select().from(schema.modelRegistry).orderBy(schema.modelRegistry.modelId),
      db.select().from(schema.runtimeSettings),
    ]);
    const slots = Object.fromEntries(
      slotRows
        .filter((row) => row.key.startsWith("model_slot_"))
        .map((row) => [row.key, row.value])
        .sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")),
    );
    const payload = JSON.stringify({
      registry: registryRows.map((row) => ({
        modelId: row.modelId,
        displayName: row.displayName,
        baseUrl: row.baseUrl,
        apiKey: row.apiKey,
        capabilities: row.capabilities,
        timeoutMs: row.timeoutMs,
        failoverTo: row.failoverTo,
        enabled: row.enabled,
      })),
      slots,
    });
    let hash = 0x811c9dc5;
    for (let i = 0; i < payload.length; i += 1) {
      hash ^= payload.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  } catch {
    return "unreadable";
  }
}

/**
 * 读取模型设置完整配置（供 agent-worker 等消费方启动时使用）。
 * DB 覆盖 env 默认值；apiKey 仅在 DB 或 env 有值时存在。
 */
export async function readModelSettingsRuntime(
  db: NodePgDatabase<typeof schema>,
  defaults: ModelSettingsDefaults,
): Promise<ModelSettingsRuntime> {
  const textName =
    (await readRow(db, TEXT_KEYS.name)) ?? defaults.textModel.name;
  const textBaseUrl =
    (await readRow(db, TEXT_KEYS.baseUrl)) ?? defaults.textModel.baseUrl;
  const textApiKey = await readRow(db, TEXT_KEYS.apiKey);
  const triageDefaults = defaults.triageModel;
  const triageName = triageDefaults
    ? ((await readRow(db, TRIAGE_KEYS.name)) ?? triageDefaults.name)
    : await readRow(db, TRIAGE_KEYS.name);
  const triageBaseUrl = triageDefaults
    ? ((await readRow(db, TRIAGE_KEYS.baseUrl)) ?? triageDefaults.baseUrl)
    : await readRow(db, TRIAGE_KEYS.baseUrl);
  const triageApiKey = await readRow(db, TRIAGE_KEYS.apiKey);
  const fastDefaults = defaults.fastModel;
  const fastName = fastDefaults
    ? ((await readRow(db, FAST_KEYS.name)) ?? fastDefaults.name)
    : await readRow(db, FAST_KEYS.name);
  const fastBaseUrl = fastDefaults
    ? ((await readRow(db, FAST_KEYS.baseUrl)) ?? fastDefaults.baseUrl)
    : await readRow(db, FAST_KEYS.baseUrl);
  const fastApiKey = await readRow(db, FAST_KEYS.apiKey);
  return {
    textModel: {
      name: textName,
      baseUrl: textBaseUrl,
      ...(textApiKey !== undefined
        ? { apiKey: textApiKey }
        : defaults.textModel.apiKey !== undefined
          ? { apiKey: defaults.textModel.apiKey }
          : {}),
    },
    ...(triageDefaults && triageName && triageBaseUrl
      ? {
          triageModel: {
            name: triageName,
            baseUrl: triageBaseUrl,
            ...(triageApiKey !== undefined
              ? { apiKey: triageApiKey }
              : triageDefaults.apiKey !== undefined
                ? { apiKey: triageDefaults.apiKey }
                : {}),
          },
        }
      : {}),
    ...(fastDefaults && fastName && fastBaseUrl
      ? {
          fastModel: {
            name: fastName,
            baseUrl: fastBaseUrl,
            ...(fastApiKey !== undefined
              ? { apiKey: fastApiKey }
              : fastDefaults.apiKey !== undefined
                ? { apiKey: fastDefaults.apiKey }
                : {}),
          },
        }
      : {}),
    modelGatewayFingerprint: await computeModelGatewayFingerprint(db),
  };
}

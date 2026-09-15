/**
 * 知识库连接器配置统一（ADR-0008）：设置中心为唯一界面入口，.env 兜底。
 *
 * 背景：设置中心「知识库连接器」表单写入 support-pipeline 行的
 * knowledgeConnector 键，但运行时过去只读 .env 的 WEKNORA_*，表单是
 * 死配置。本模块把两者合一：
 *
 * - 优先级：界面 knowledgeConnector（weknora 预设且 retrieveUrl 非空）
 *   > .env WEKNORA_* > 未配置。界面各字段缺省时逐项回落 env 值
 *   （如只填了端点没填 key，则沿用 env 的 apiKey）。
 * - retrieveUrl 是检索端点（如 http://host/api/v1/knowledge-search），
 *   末尾的 /knowledge-search 剥离为客户端 baseUrl。
 * - 认证：bearer → Authorization: Bearer <authValue>；header →
 *   <authHeader>: <authValue>；none/未填 authValue → 回落 env（x-api-key）。
 * - knowledgeBaseIds（逗号/空白分隔）：非空则限定检索范围；留空 = 客户端
 *   自动发现全部知识库。
 * - type 为其他值（custom-rest）暂不接线：按未配置处理回落 env，界面
 *   已将该选项标注为预留。
 *
 * 热加载沿用 model-settings-hot 的轮询模式：每 intervalMs 重读
 * extension_settings（带 30s 进程内缓存），快照变化才 updateOptions；
 * 读失败保持旧快照继续服务（fail-safe）。
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../postgres/schema.js";
import {
  createCachedExtensionSettingsReader,
} from "../settings/extension-settings.js";
import {
  WeKnoraKnowledgeClient,
  type WeKnoraClientOptions,
} from "./weknora-knowledge-client.js";

type Database = NodePgDatabase<typeof schema>;

/** 设置中心连接器分节的宽松形状；只读已知字段，其余不进入运行时视野。 */
export type KnowledgeConnectorSection = {
  type?: unknown;
  retrieveUrl?: unknown;
  authMode?: unknown;
  authHeader?: unknown;
  authValue?: unknown;
  knowledgeBaseIds?: unknown;
};

const PIPELINE_SETTINGS_REF = {
  solutionId: "weflow.customer-support",
  extensionId: "support-pipeline",
} as const;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 解析逗号/顿号/分号/空白分隔的知识库 ID 列表；空串返回 undefined（= 自动发现）。 */
export function parseKnowledgeBaseIdList(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const ids = value
    .split(/[,;，；、\s]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

/** retrieveUrl（…/knowledge-search）→ 客户端 baseUrl（剥离检索端点后缀）。 */
export function retrieveUrlToBaseUrl(retrieveUrl: string): string {
  return retrieveUrl.replace(/\/knowledge-search\/?$/i, "").replace(/\/+$/, "");
}

/**
 * 界面连接器配置 → 客户端选项。
 * 界面未配置（weknora 预设 + retrieveUrl 空）时返回 fallback（env 兜底）。
 */
export function resolveWeKnoraClientOptions(
  section: unknown,
  fallback: WeKnoraClientOptions | undefined,
): WeKnoraClientOptions | undefined {
  const connector: KnowledgeConnectorSection =
    typeof section === "object" && section !== null ? section : {};
  const type = asString(connector.type).toLowerCase();
  const retrieveUrl = asString(connector.retrieveUrl);
  const uiConfigured =
    retrieveUrl.length > 0 && (type === "" || type === "weknora");
  if (!uiConfigured) return fallback;

  const authValue = asString(connector.authValue);
  const authMode = asString(connector.authMode).toLowerCase();
  let authHeaderName = fallback?.authHeaderName;
  let authHeaderValue = fallback?.authHeaderValue;
  let apiKey = fallback?.apiKey;
  if (authValue) {
    apiKey = undefined;
    if (authMode === "bearer") {
      authHeaderName = "Authorization";
      authHeaderValue = `Bearer ${authValue}`;
    } else if (authMode === "header") {
      authHeaderName = asString(connector.authHeader) || "x-api-key";
      authHeaderValue = authValue;
    } else {
      // none / 未识别：明确不带自定义认证，回落 env key（若有）。
      authHeaderName = undefined;
      authHeaderValue = undefined;
    }
  }

  const uiBase = retrieveUrlToBaseUrl(retrieveUrl);
  return {
    baseUrl: uiBase || fallback?.baseUrl || "",
    apiKey,
    authHeaderName,
    authHeaderValue,
    timeoutMs: fallback?.timeoutMs ?? 15_000,
    knowledgeBaseIds:
      parseKnowledgeBaseIdList(connector.knowledgeBaseIds) ??
      fallback?.knowledgeBaseIds,
    fetch: fallback?.fetch,
  };
}

/**
 * 自适应知识客户端：构造时按「界面 > env」完成初始装配，随后每 30s
 * 轮询设置中心，快照变化才 updateOptions（读失败保持旧快照）。
 *
 * currentOptions() 返回最近一次生效快照（含调用时的惰性刷新触发），
 * 供 api 进程的代理路由 / 系统状态检查按请求取用。
 */
export async function createAdaptiveKnowledgeClient(
  db: Database,
  envOptions: WeKnoraClientOptions | undefined,
  input: {
    intervalMs?: number;
    ttlMs?: number;
    /** 测试注入：覆盖 support-pipeline 行读取（缺省走 DB + 进程内缓存）。 */
    readSettings?: () => Promise<unknown>;
  } = {},
): Promise<{
  client: WeKnoraKnowledgeClient;
  currentOptions(): WeKnoraClientOptions | undefined;
  stop(): void;
}> {
  const readSettings =
    input.readSettings ??
    createCachedExtensionSettingsReader(db, {
      ...PIPELINE_SETTINGS_REF,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    });
  const resolve = async (): Promise<WeKnoraClientOptions | undefined> => {
    const row = await readSettings();
    const section =
      typeof row === "object" && row !== null
        ? (row as Record<string, unknown>).knowledgeConnector
        : undefined;
    return resolveWeKnoraClientOptions(section, envOptions);
  };

  let latest = await resolve();
  const client = new WeKnoraKnowledgeClient(latest);

  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const next = await resolve();
      if (JSON.stringify(next) !== JSON.stringify(latest)) {
        latest = next;
        client.updateOptions(next);
      }
    } catch {
      // 读失败保持旧快照继续服务，下个周期重试。
    } finally {
      checking = false;
    }
  };
  const timer: ReturnType<typeof setInterval> = setInterval(
    () => void check(),
    input.intervalMs ?? 30_000,
  );
  timer.unref();

  return {
    client,
    currentOptions: () => latest,
    stop: () => {
      clearInterval(timer);
    },
  };
}

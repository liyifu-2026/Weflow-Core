/**
 * 模型网关（R2 设置中心 · 模型分区）。
 *
 * 统一模型注册表（operations.model_registry）：
 * - 模型 = 名称 + 端点 + 密钥 + 能力标签（text/vision/asr）+ 故障转移链
 * - API key 属于 secret：读取视图永不回显，只暴露 hasApiKey
 * - 所有修改写 audit.events（operationId 分组），与 runtime-settings 同法
 * - 槽位（text/vision/asr/triage/fast）在 runtime_settings 中登记
 *   model_slot_* → model_id，运行时按槽位解析出故障转移链
 *
 * 轻量内建，不引外部依赖；热更新复用既有轮询失效模式
 * （消费方每 15s 重读，保存后即时生效无需重启）。
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { TextModel } from "../../model/contracts/text-model.js";
import type { FailoverLink } from "./model-failover.js";

/** 合法能力标签（总纲：文本/视觉/语音） */
export const MODEL_CAPABILITIES = ["text", "vision", "asr"] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** ASR 端点协议：MiMo 内联音频 vs 标准 audio/transcriptions multipart */
export const MODEL_PROTOCOLS = ["chat_inline", "audio_transcriptions"] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];

export function isProtocolListValue(value: unknown): value is ModelProtocol {
  return (
    typeof value === "string" &&
    (MODEL_PROTOCOLS as readonly string[]).includes(value)
  );
}

/** 平台模型槽位（既有五槽位；新槽位不得随意增加） */
export const MODEL_SLOTS = ["text", "vision", "asr", "triage", "fast"] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];

const SLOT_KEY: Record<ModelSlot, string> = {
  text: "model_slot_text",
  vision: "model_slot_vision",
  asr: "model_slot_asr",
  triage: "model_slot_triage",
  fast: "model_slot_fast",
};

/** 模型注册条目的对外视图（apiKey 永不回显） */
export type ModelRegistryEntryView = {
  modelId: string;
  displayName: string;
  baseUrl: string;
  hasApiKey: boolean;
  capabilities: string[];
  protocol: ModelProtocol;
  timeoutMs: number;
  failoverTo: string | null;
  enabled: boolean;
};

/** 模型注册条目补丁 */
export type ModelRegistryPatch = {
  displayName?: string;
  baseUrl?: string;
  /** 空串/缺省 = 保持原值 */
  apiKey?: string;
  capabilities?: string[];
  protocol?: ModelProtocol;
  timeoutMs?: number;
  failoverTo?: string | null;
  enabled?: boolean;
};

function isCapabilityList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "string" &&
        (MODEL_CAPABILITIES as readonly string[]).includes(item),
    )
  );
}

function toView(
  row: typeof schema.modelRegistry.$inferSelect,
): ModelRegistryEntryView {
  return {
    modelId: row.modelId,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    hasApiKey: Boolean(row.apiKey),
    capabilities: row.capabilities,
    protocol: isProtocolListValue(row.protocol) ? row.protocol : "chat_inline",
    timeoutMs: row.timeoutMs,
    failoverTo: row.failoverTo,
    enabled: row.enabled,
  };
}

/** 读取模型注册表（全量，含禁用项） */
export async function listModelRegistry(
  db: NodePgDatabase<typeof schema>,
): Promise<ModelRegistryEntryView[]> {
  const rows = await db
    .select()
    .from(schema.modelRegistry)
    .orderBy(schema.modelRegistry.createdAt);
  return rows.map(toView);
}

export type ModelRegistryWriteError =
  | { status: "ok"; model: ModelRegistryEntryView }
  | { status: "not_found" }
  | { status: "failover_cycle" }
  | { status: "invalid_capabilities" };

/** 检测从 start 沿 failover_to 是否可达 target（环保护） */
async function createsCycle(
  db: NodePgDatabase<typeof schema>,
  start: string,
  target: string,
): Promise<boolean> {
  let current = target;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === start) return true;
    const [row] = await db
      .select({ failoverTo: schema.modelRegistry.failoverTo })
      .from(schema.modelRegistry)
      .where(eq(schema.modelRegistry.modelId, current))
      .limit(1);
    if (!row?.failoverTo) return false;
    current = row.failoverTo;
  }
  return true;
}

/** 创建/更新模型注册条目（写审计；环路由拒绝） */
export async function upsertModelRegistryEntry(
  db: NodePgDatabase<typeof schema>,
  input: {
    actorUserId: string;
    sourceIp: string;
    modelId: string;
    patch: ModelRegistryPatch;
  },
): Promise<ModelRegistryWriteError> {
  if (input.patch.capabilities !== undefined) {
    if (!isCapabilityList(input.patch.capabilities)) {
      return { status: "invalid_capabilities" };
    }
  }
  const [existing] = await db
    .select()
    .from(schema.modelRegistry)
    .where(eq(schema.modelRegistry.modelId, input.modelId))
    .limit(1);

  const failoverTo =
    input.patch.failoverTo === undefined
      ? (existing?.failoverTo ?? null)
      : input.patch.failoverTo;
  // 自环与环链拒绝：故障转移链必须是 DAG（深度上限 8）
  if (failoverTo && (await createsCycle(db, input.modelId, failoverTo))) {
    return { status: "failover_cycle" };
  }
  if (failoverTo) {
    const [target] = await db
      .select({ modelId: schema.modelRegistry.modelId })
      .from(schema.modelRegistry)
      .where(eq(schema.modelRegistry.modelId, failoverTo))
      .limit(1);
    if (!target) return { status: "not_found" };
  }

  const operationId = randomUUID();
  const changed: string[] = [];
  await db.transaction(async (tx) => {
    const nextValues = {
      displayName:
        input.patch.displayName ?? existing?.displayName ?? input.modelId,
      baseUrl: input.patch.baseUrl ?? existing?.baseUrl ?? "",
      ...(input.patch.apiKey !== undefined && input.patch.apiKey.trim() !== ""
        ? { apiKey: input.patch.apiKey.trim() }
        : {}),
      ...(input.patch.capabilities !== undefined
        ? { capabilities: input.patch.capabilities }
        : {}),
      ...(input.patch.protocol !== undefined
        ? { protocol: input.patch.protocol }
        : {}),
      ...(input.patch.timeoutMs !== undefined
        ? {
            timeoutMs: Math.max(
              1_000,
              Math.min(300_000, input.patch.timeoutMs),
            ),
          }
        : {}),
      failoverTo,
      ...(input.patch.enabled !== undefined
        ? { enabled: input.patch.enabled }
        : {}),
      updatedAt: new Date(),
      updatedBy: input.actorUserId,
    };
    if (existing) {
      await tx
        .update(schema.modelRegistry)
        .set(nextValues)
        .where(eq(schema.modelRegistry.modelId, input.modelId));
    } else {
      await tx.insert(schema.modelRegistry).values({
        modelId: input.modelId,
        ...nextValues,
      });
    }
    await tx.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: input.actorUserId,
      eventType: "operator.model_registry_updated",
      subjectType: "model_registry",
      subjectId: input.modelId,
      sourceIp: input.sourceIp,
      metadata: {
        operationId,
        fields: Object.keys(input.patch).join(","),
      },
    });
    changed.push(input.modelId);
  });

  const [updated] = await db
    .select()
    .from(schema.modelRegistry)
    .where(eq(schema.modelRegistry.modelId, input.modelId))
    .limit(1);
  return updated
    ? { status: "ok", model: toView(updated) }
    : { status: "not_found" };
}

/** 删除模型注册条目（槽位引用它的行保留但解析为空） */
export async function deleteModelRegistryEntry(
  db: NodePgDatabase<typeof schema>,
  input: { actorUserId: string; sourceIp: string; modelId: string },
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(schema.modelRegistry)
    .where(eq(schema.modelRegistry.modelId, input.modelId))
    .returning({ modelId: schema.modelRegistry.modelId });
  if (result.length === 0) return { deleted: false };
  await db.insert(schema.auditEvents).values({
    auditId: randomUUID(),
    actorUserId: input.actorUserId,
    eventType: "operator.model_registry_deleted",
    subjectType: "model_registry",
    subjectId: input.modelId,
    sourceIp: input.sourceIp,
    metadata: { operationId: randomUUID() },
  });
  return { deleted: true };
}

// ── 槽位绑定 ──────────────────────────────────────────────────────

/** 槽位视图：槽位 → 绑定的模型条目 */
export type SlotBindingView = {
  slots: Record<
    ModelSlot,
    { modelId: string | null; modelName: string | null }
  >;
};

export async function readSlotBindings(
  db: NodePgDatabase<typeof schema>,
): Promise<Record<ModelSlot, string | null>> {
  const rows = await db.select().from(schema.runtimeSettings);
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const out = Object.fromEntries(
    MODEL_SLOTS.map((slot) => [slot, byKey.get(SLOT_KEY[slot]) ?? null]),
  ) as Record<ModelSlot, string | null>;
  return out;
}

/** 各槽位要求模型具备的能力（未列出的槽位不做能力约束） */
const SLOT_REQUIRED_CAPABILITY: Partial<Record<ModelSlot, ModelCapability>> = {
  asr: "asr",
  vision: "vision",
  text: "text",
};

/** 绑定槽位到模型（modelId=null 解绑；写审计；能力不符拒绝） */
export async function bindModelSlot(
  db: NodePgDatabase<typeof schema>,
  input: {
    actorUserId: string;
    sourceIp: string;
    slot: ModelSlot;
    modelId: string | null;
  },
): Promise<{
  bound: boolean;
  notFound?: boolean;
  capabilityMismatch?: boolean;
}> {
  if (input.modelId) {
    const [model] = await db
      .select({
        modelId: schema.modelRegistry.modelId,
        capabilities: schema.modelRegistry.capabilities,
        enabled: schema.modelRegistry.enabled,
      })
      .from(schema.modelRegistry)
      .where(eq(schema.modelRegistry.modelId, input.modelId))
      .limit(1);
    if (!model) return { bound: false, notFound: true };
    const required = SLOT_REQUIRED_CAPABILITY[input.slot];
    if (required && !model.capabilities.includes(required)) {
      return { bound: false, capabilityMismatch: true };
    }
  }
  const key = SLOT_KEY[input.slot];
  const nextValue = input.modelId ?? "";
  await db
    .insert(schema.runtimeSettings)
    .values({ key, value: nextValue, updatedBy: input.actorUserId })
    .onConflictDoUpdate({
      target: schema.runtimeSettings.key,
      set: {
        value: nextValue,
        updatedBy: input.actorUserId,
        updatedAt: new Date(),
      },
    });
  await db.insert(schema.auditEvents).values({
    auditId: randomUUID(),
    actorUserId: input.actorUserId,
    eventType: "operator.model_slot_bound",
    subjectType: "model_slot",
    subjectId: key,
    sourceIp: input.sourceIp,
    metadata: { operationId: randomUUID(), modelId: nextValue },
  });
  return { bound: true };
}

// ── 运行时解析（供组合根构建客户端；含密钥，不得经 HTTP 外露） ──────

/** 运行时槽位端点（含密钥；组合根专用） */
export type SlotEndpointRuntime = {
  modelId: string;
  displayName: string;
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
  /** 能力标签（如 text/vision/asr）；消费方据此做能力分流（识图走主力或视觉槽位） */
  capabilities: string[];
  /** ASR 端点协议；非 asr 用途的模型固定为 chat_inline */
  protocol: ModelProtocol;
};

/**
 * 解析「测试连接」探测端点：优先表单覆盖值（未保存的编辑中草稿），
 * 缺省回落注册表行（含已存密钥）。注册表无该条目且无 baseUrl 覆盖时
 * 返回 null（由路由映射 404）。含密钥，仅供服务端探测，不得外露。
 */
export async function resolveModelProbeEndpoint(
  db: NodePgDatabase<typeof schema>,
  modelId: string,
  overrides: {
    baseUrl?: string | undefined;
    apiKey?: string | undefined;
    displayName?: string | undefined;
  },
): Promise<SlotEndpointRuntime | null> {
  const [row] = await db
    .select()
    .from(schema.modelRegistry)
    .where(eq(schema.modelRegistry.modelId, modelId))
    .limit(1);
  const baseUrl = overrides.baseUrl ?? row?.baseUrl ?? "";
  if (!baseUrl) return null;
  const apiKey =
    overrides.apiKey && overrides.apiKey.trim() !== ""
      ? overrides.apiKey.trim()
      : row?.apiKey ?? undefined;
  return {
    modelId,
    displayName: overrides.displayName ?? row?.displayName ?? modelId,
    baseUrl,
    apiKey,
    timeoutMs: row?.timeoutMs ?? 30_000,
    capabilities: row?.capabilities ?? [],
    protocol: isProtocolListValue(row?.protocol) ? row.protocol : "chat_inline",
  };
}

/** 按槽位解析运行时端点（主 + 单跳故障转移）；未绑定/禁用返回空数组 */
export async function resolveSlotChainRuntime(
  db: NodePgDatabase<typeof schema>,
  slot: ModelSlot,
): Promise<SlotEndpointRuntime[]> {
  const bindings = await readSlotBindings(db);
  const boundId = bindings[slot];
  if (!boundId) return [];
  const rows = await db.select().from(schema.modelRegistry);
  const byId = new Map(rows.map((row) => [row.modelId, row]));
  const toEndpoint = (
    row: typeof schema.modelRegistry.$inferSelect,
  ): SlotEndpointRuntime => ({
    modelId: row.modelId,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey ?? undefined,
    timeoutMs: row.timeoutMs,
    capabilities: row.capabilities,
    protocol: isProtocolListValue(row.protocol) ? row.protocol : "chat_inline",
  });
  const primary = byId.get(boundId);
  if (!primary || !primary.enabled) return [];
  // 运行时能力兜底：绑定校验旁路（如直接改库）产生的错误绑定在此过滤，
  // 槽位解析为空 → 消费方回落 .env 旧配置，避免把音频发给纯文本端点等。
  const required = SLOT_REQUIRED_CAPABILITY[slot];
  if (required && !primary.capabilities.includes(required)) return [];
  const chain = [toEndpoint(primary)];
  if (primary.failoverTo) {
    const backup = byId.get(primary.failoverTo);
    if (backup && backup.enabled) chain.push(toEndpoint(backup));
  }
  return chain;
}

/**
 * 文本主模型名的唯一事实源（配置收敛）：
 * - text 槽位绑定了启用的注册表模型 → 返回其 displayName（source: slot），
 *   与 hotTextClient 实际请求的模型一致（网关链主端点同名）；
 * - 未绑定/禁用/读取失败 → 回落调用方传入的旧值（runtime_settings 的
 *   text_model 扁平键或 env 默认；迁移兼容，槽位绑定后旧键即失效）。
 */
export async function resolvePrimaryTextModelName(
  db: NodePgDatabase<typeof schema>,
  legacyFallback: string,
): Promise<{ name: string; source: "slot" | "legacy" }> {
  try {
    const chain = await resolveSlotChainRuntime(db, "text");
    const primary = chain[0];
    if (chain.length > 0 && primary) {
      return { name: primary.displayName, source: "slot" };
    }
  } catch {
    // 槽位解析失败不阻断轮次：回落旧配置
  }
  return { name: legacyFallback, source: "legacy" };
}

/**
 * 按 text 槽位从注册表解析故障转移链，并把注册条目物化为可调用客户端。
 * 绑定了启用模型时返回 [主 → failoverTo] 运行时链（含密钥，仅进程内使用）；
 * 未绑定/读取失败返回 undefined（调用方回退 legacy 模型设置）。
 * clientFactory 可注入（测试无需真实 HTTP 客户端）。
 */
export async function buildTextFailoverChain(
  db: NodePgDatabase<typeof schema>,
  options: {
    clientFactory: (endpoint: SlotEndpointRuntime) => TextModel;
    logger: Logger;
  },
): Promise<FailoverLink[] | undefined> {
  try {
    const endpoints = await resolveSlotChainRuntime(db, "text");
    if (endpoints.length === 0) return undefined;
    return endpoints.map((endpoint) => ({
      modelId: endpoint.modelId,
      displayName: endpoint.displayName,
      client: options.clientFactory(endpoint),
    }));
  } catch (error) {
    options.logger.warn(
      { err: error },
      "model gateway chain resolution failed; falling back to legacy model settings",
    );
    return undefined;
  }
}

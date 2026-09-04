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
import * as schema from "../../../infrastructure/postgres/schema.js";

/** 合法能力标签（总纲：文本/视觉/语音） */
export const MODEL_CAPABILITIES = ["text", "vision", "asr"] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** 平台模型槽位（既有五槽位；新槽位不得随意增加） */
export const MODEL_SLOTS = [
  "text",
  "vision",
  "asr",
  "triage",
  "fast",
] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];

const SLOT_KEY: Record<ModelSlot, string> = {
  text: "model_slot_text",
  vision: "model_slot_vision",
  asr: "model_slot_asr",
  triage: "model_slot_triage",
  fast: "model_slot_fast",
};

export function slotSettingKey(slot: ModelSlot): string {
  return SLOT_KEY[slot];
}

/** 模型注册条目的对外视图（apiKey 永不回显） */
export type ModelRegistryEntryView = {
  modelId: string;
  displayName: string;
  baseUrl: string;
  hasApiKey: boolean;
  capabilities: string[];
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

function toView(row: typeof schema.modelRegistry.$inferSelect): ModelRegistryEntryView {
  return {
    modelId: row.modelId,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    hasApiKey: Boolean(row.apiKey),
    capabilities: row.capabilities,
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
      ...(input.patch.timeoutMs !== undefined
        ? { timeoutMs: Math.max(1_000, Math.min(300_000, input.patch.timeoutMs)) }
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
  return updated ? { status: "ok", model: toView(updated) } : { status: "not_found" };
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
  slots: Record<ModelSlot, { modelId: string | null; modelName: string | null }>;
};

export async function readSlotBindings(
  db: NodePgDatabase<typeof schema>,
): Promise<Record<ModelSlot, string | null>> {
  const rows = await db
    .select()
    .from(schema.runtimeSettings);
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const out = Object.fromEntries(
    MODEL_SLOTS.map((slot) => [slot, byKey.get(SLOT_KEY[slot]) ?? null]),
  ) as Record<ModelSlot, string | null>;
  return out;
}

/** 绑定槽位到模型（modelId=null 解绑；写审计） */
export async function bindModelSlot(
  db: NodePgDatabase<typeof schema>,
  input: {
    actorUserId: string;
    sourceIp: string;
    slot: ModelSlot;
    modelId: string | null;
  },
): Promise<{ bound: boolean; notFound?: boolean }> {
  if (input.modelId) {
    const [model] = await db
      .select({ modelId: schema.modelRegistry.modelId })
      .from(schema.modelRegistry)
      .where(eq(schema.modelRegistry.modelId, input.modelId))
      .limit(1);
    if (!model) return { bound: false, notFound: true };
  }
  const key = SLOT_KEY[input.slot];
  const nextValue = input.modelId ?? "";
  await db
    .insert(schema.runtimeSettings)
    .values({ key, value: nextValue, updatedBy: input.actorUserId })
    .onConflictDoUpdate({
      target: schema.runtimeSettings.key,
      set: { value: nextValue, updatedBy: input.actorUserId, updatedAt: new Date() },
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
};

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
  const toEndpoint = (row: typeof schema.modelRegistry.$inferSelect): SlotEndpointRuntime => ({
    modelId: row.modelId,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey ?? undefined,
    timeoutMs: row.timeoutMs,
  });
  const primary = byId.get(boundId);
  if (!primary || !primary.enabled) return [];
  const chain = [toEndpoint(primary)];
  if (primary.failoverTo) {
    const backup = byId.get(primary.failoverTo);
    if (backup && backup.enabled) chain.push(toEndpoint(backup));
  }
  return chain;
}

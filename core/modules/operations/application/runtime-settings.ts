/**
 * 运营运行时设置（Operator Control Plane）
 *
 * 唯一事实来源：operations.runtime_settings 表。
 * 职责：
 * - 统一 Zod Schema + 服务端模型 allowlist：禁止业务代码直接读裸 key/value
 * - fail-safe：缺失/非法配置回退明确默认值并记录错误日志，绝不带病运行
 * - 缓存策略：安全关键开关（建 Turn 边界、发送边界）必须 fresh 读；
 *   普通配置（knowledge/memory/vision/模型名）允许 10s 短缓存
 * - 所有修改写入 audit.events（previous/next + operationId 分组），支持回滚
 *
 * core / agent-worker / ingestion-worker 三进程共用本模块（只依赖 PostgreSQL）。
 */
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { pino, type Logger } from "pino";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

const DEFAULT_LOGGER = pino({ level: "silent" });

/** 服务端允许模型注册表：UI 只能选择这里列出的模型 */
export const TEXT_MODEL_ALLOWLIST = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
] as const;

export const VISION_MODEL_ALLOWLIST = ["mimo-v2.5"] as const;

/** 运行时设置的类型化结构（业务代码只允许通过它访问） */
export type RuntimeSettings = {
  agentEnabled: boolean;
  autoSendEnabled: boolean;
  knowledgeEnabled: boolean;
  memoryEnabled: boolean;
  visionEnabled: boolean;
  textModel: (typeof TEXT_MODEL_ALLOWLIST)[number];
  visionModel: (typeof VISION_MODEL_ALLOWLIST)[number];
};

/** 明确默认值（配置缺失/非法时 fail-safe 回退目标） */
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  agentEnabled: true,
  autoSendEnabled: true,
  knowledgeEnabled: true,
  memoryEnabled: true,
  visionEnabled: true,
  textModel: "deepseek-v4-flash",
  visionModel: "mimo-v2.5",
};

/** 字段 → DB key 映射 */
const FIELD_TO_KEY: Record<keyof RuntimeSettings, string> = {
  agentEnabled: "agent_enabled",
  autoSendEnabled: "auto_send_enabled",
  knowledgeEnabled: "knowledge_enabled",
  memoryEnabled: "memory_enabled",
  visionEnabled: "vision_enabled",
  textModel: "text_model",
  visionModel: "vision_model",
};

const KEY_TO_FIELD: Record<string, keyof RuntimeSettings> = Object.fromEntries(
  Object.entries(FIELD_TO_KEY).map(([field, key]) => [
    key,
    field as keyof RuntimeSettings,
  ]),
);

const BOOLEAN_FIELDS = new Set<keyof RuntimeSettings>([
  "agentEnabled",
  "autoSendEnabled",
  "knowledgeEnabled",
  "memoryEnabled",
  "visionEnabled",
]);

/** 普通配置缓存（安全关键路径一律 fresh 读，不经过此缓存） */
let cached: RuntimeSettings | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10_000;

function invalidateCache(): void {
  cached = null;
  cachedAt = 0;
}

/** 单字段校验：非法返回 undefined（fail-safe 回退默认值） */
function parseField(
  field: keyof RuntimeSettings,
  raw: string,
): boolean | string | undefined {
  if (BOOLEAN_FIELDS.has(field)) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return undefined;
  }
  if (field === "textModel") {
    return (TEXT_MODEL_ALLOWLIST as readonly string[]).includes(raw)
      ? raw
      : undefined;
  }
  if (field === "visionModel") {
    return (VISION_MODEL_ALLOWLIST as readonly string[]).includes(raw)
      ? raw
      : undefined;
  }
  return undefined;
}

/** 以默认值为基底合并 DB 行值；逐字段校验，非法/缺失回退默认并记录 */
function mergeWithDefaults(
  values: Record<string, string>,
  logger: Logger,
): RuntimeSettings {
  const out: RuntimeSettings = { ...DEFAULT_RUNTIME_SETTINGS };
  for (const [field, key] of Object.entries(FIELD_TO_KEY)) {
    const raw = values[key];
    if (raw === undefined) continue;
    const parsed = parseField(field as keyof RuntimeSettings, raw);
    if (parsed === undefined) {
      logger.error(
        { key, value: raw },
        "runtime setting invalid, falling back to default",
      );
      continue;
    }
    (out as Record<string, unknown>)[field] = parsed;
  }
  return out;
}

/** 读取运行时设置；安全关键路径传 { fresh: true } 绕过缓存 */
export async function readRuntimeSettings(
  db: NodePgDatabase<typeof schema>,
  logger: Logger = DEFAULT_LOGGER,
  options: { fresh?: boolean } = {},
): Promise<RuntimeSettings> {
  if (
    !options.fresh &&
    cached !== null &&
    Date.now() - cachedAt < CACHE_TTL_MS
  ) {
    return cached;
  }
  const rows = await db.select().from(schema.runtimeSettings);
  const values: Record<string, string> = {};
  for (const row of rows) values[row.key] = row.value;
  const settings = mergeWithDefaults(values, logger);
  if (!options.fresh) {
    cached = settings;
    cachedAt = Date.now();
  }
  return settings;
}

/** 写入路径严格校验：非法字段值直接抛错，不允许脏数据入库 */
function assertValidPatch(
  patch: Partial<RuntimeSettings>,
): asserts patch is Record<string, boolean | string> {
  for (const [field, value] of Object.entries(patch)) {
    if (typeof value !== "boolean" && typeof value !== "string") {
      throw new Error(`invalid runtime setting value for ${field}`);
    }
    const parsed = parseField(field as keyof RuntimeSettings, String(value));
    if (parsed === undefined) {
      throw new Error(
        `invalid runtime setting ${field}=${String(value)} (not in allowlist or wrong type)`,
      );
    }
  }
}

export type SettingsChange = {
  key: string;
  previous: string;
  next: string;
};

/**
 * 更新运行时设置（写审计，previous/next + operationId 分组）。
 * 返回最新设置与变更明细。
 */
export async function updateRuntimeSettings(
  db: NodePgDatabase<typeof schema>,
  logger: Logger = DEFAULT_LOGGER,
  input: {
    actorUserId: string;
    sourceIp: string;
    patch: Partial<RuntimeSettings>;
  },
): Promise<{ settings: RuntimeSettings; changed: SettingsChange[] }> {
  assertValidPatch(input.patch);
  const operationId = randomUUID();
  const changed: SettingsChange[] = [];
  await db.transaction(async (transaction) => {
    const current = await readRuntimeSettings(transaction, logger, {
      fresh: true,
    });
    for (const [field, nextValue] of Object.entries(input.patch)) {
      const fieldName = field as keyof RuntimeSettings;
      const key = FIELD_TO_KEY[fieldName];
      const currentValue = String(
        (current as Record<string, unknown>)[fieldName],
      );
      const next = String(nextValue);
      if (currentValue === next) continue;
      await transaction
        .insert(schema.runtimeSettings)
        .values({
          key,
          value: next,
          updatedBy: input.actorUserId,
        })
        .onConflictDoUpdate({
          target: schema.runtimeSettings.key,
          set: {
            value: next,
            updatedBy: input.actorUserId,
            updatedAt: new Date(),
          },
        });
      await transaction.insert(schema.auditEvents).values({
        auditId: randomUUID(),
        actorUserId: input.actorUserId,
        eventType: "operator.runtime_settings_updated",
        subjectType: "runtime_settings",
        subjectId: key,
        sourceIp: input.sourceIp,
        metadata: {
          operationId,
          key,
          previousValue: currentValue,
          nextValue: next,
        },
      });
      changed.push({ key, previous: currentValue, next });
    }
  });
  invalidateCache();
  return {
    settings: await readRuntimeSettings(db, logger, { fresh: true }),
    changed,
  };
}

/**
 * 回滚最近一次设置修改操作。
 * 回滚值必须重新通过字段校验（allowlist），绝不裸写历史数据；
 * 回滚本身再写一条审计事件。
 */
export async function rollbackRuntimeSettings(
  db: NodePgDatabase<typeof schema>,
  logger: Logger = DEFAULT_LOGGER,
  input: { actorUserId: string; sourceIp: string },
): Promise<{ settings: RuntimeSettings; rolledBack: SettingsChange[] }> {
  const [latest] = await db
    .select()
    .from(schema.auditEvents)
    .where(
      eq(schema.auditEvents.eventType, "operator.runtime_settings_updated"),
    )
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(1);
  const rollbackOperationId = latest?.metadata.operationId;
  if (!latest || !rollbackOperationId) {
    return {
      settings: await readRuntimeSettings(db, logger, { fresh: true }),
      rolledBack: [],
    };
  }
  const events = await db
    .select()
    .from(schema.auditEvents)
    .where(
      eq(schema.auditEvents.eventType, "operator.runtime_settings_updated"),
    )
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(50);
  const operationEvents = events.filter(
    (event) => event.metadata.operationId === rollbackOperationId,
  );
  const rolledBack: SettingsChange[] = [];
  await db.transaction(async (transaction) => {
    const current = await readRuntimeSettings(transaction, logger, {
      fresh: true,
    });
    for (const event of operationEvents) {
      const key = event.subjectId;
      const previous = event.metadata.previousValue;
      if (!key || previous === undefined) continue;
      const field = KEY_TO_FIELD[key];
      if (!field || parseField(field, previous) === undefined) {
        throw new Error(`rollback rejected: ${key}=${previous} not valid`);
      }
      const currentValue = String((current as Record<string, unknown>)[field]);
      if (currentValue === previous) continue;
      await transaction
        .insert(schema.runtimeSettings)
        .values({ key, value: previous, updatedBy: input.actorUserId })
        .onConflictDoUpdate({
          target: schema.runtimeSettings.key,
          set: {
            value: previous,
            updatedBy: input.actorUserId,
            updatedAt: new Date(),
          },
        });
      await transaction.insert(schema.auditEvents).values({
        auditId: randomUUID(),
        actorUserId: input.actorUserId,
        eventType: "operator.runtime_settings_rolled_back",
        subjectType: "runtime_settings",
        subjectId: key,
        sourceIp: input.sourceIp,
        metadata: {
          operationId: `rollback:${rollbackOperationId}`,
          key,
          previousValue: currentValue,
          nextValue: previous,
        },
      });
      rolledBack.push({ key, previous: currentValue, next: previous });
    }
  });
  invalidateCache();
  return {
    settings: await readRuntimeSettings(db, logger, { fresh: true }),
    rolledBack,
  };
}

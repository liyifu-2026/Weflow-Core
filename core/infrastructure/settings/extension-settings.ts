/**
 * 扩展设置读取（solution.extension_settings 表，R3 后成为通用设置存储）。
 *
 * 设置中心（support-web）通过通用设置路由写入 JSON；Core 侧消费方（如
 * agent-worker 的 pipeline 策略、行为参数）以带内存缓存的读取器消费，
 * 默认 TTL 30 秒，避免每个 Turn 都打库。
 *
 * R3 平台化拆除：表的主键从 (solution_id, extension_id) 收敛为
 * (scope, key)，调用侧的 "weflow.customer-support" / "support-pipeline"
 * 参数语义不变，只是列名更通用。
 */

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../postgres/schema.js";

type Database = NodePgDatabase<typeof schema>;

/** 读取一份扩展设置的原始 JSON；不存在时返回 undefined */
export async function readSolutionExtensionSettings(
  db: Database,
  input: { solutionId: string; extensionId: string },
): Promise<unknown> {
  const rows = await db
    .select({ settingsJson: schema.solutionExtensionSettings.settingsJson })
    .from(schema.solutionExtensionSettings)
    .where(
      and(
        eq(schema.solutionExtensionSettings.scope, input.solutionId),
        eq(schema.solutionExtensionSettings.key, input.extensionId),
      ),
    )
    .limit(1);
  return rows[0]?.settingsJson ?? undefined;
}

/**
 * 创建带进程内缓存的扩展设置读取器。
 * 并发首次加载共享同一个 in-flight Promise；TTL 过期后的下一次调用重新拉取。
 */
export function createCachedExtensionSettingsReader(
  db: Database,
  input: { solutionId: string; extensionId: string; ttlMs?: number },
): () => Promise<unknown> {
  const ttlMs = input.ttlMs ?? 30_000;
  let cached: unknown;
  let fetchedAt = 0;
  let inflight: Promise<unknown> | undefined;

  return () => {
    if (inflight) return inflight;
    if (Date.now() - fetchedAt < ttlMs) {
      return Promise.resolve(cached);
    }
    inflight = readSolutionExtensionSettings(db, input)
      .then((settings) => {
        cached = settings;
        fetchedAt = Date.now();
        return settings;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

/** 行为设置命名空间绑定：由部署配置提供（BEHAVIOR_SETTINGS_REF），引擎不持字面量 */
export type ExtensionSettingsRef = {
  solutionId: string;
  extensionId: string;
};

/**
 * 可选命名的缓存读取器：部署未绑定命名空间（纯平台模式）时恒返回
 * undefined——消费方各自回落中立默认，等价于"业务插件未安装"。
 */
export function createOptionalCachedExtensionSettingsReader(
  db: Database,
  ref: ExtensionSettingsRef | undefined,
  ttlMs?: number,
): () => Promise<unknown> {
  if (!ref) return () => Promise.resolve(undefined);
  return createCachedExtensionSettingsReader(db, {
    solutionId: ref.solutionId,
    extensionId: ref.extensionId,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
}

/** 写入（upsert）一份扩展设置；updatedBy 记录操作者 */
export async function writeSolutionExtensionSettings(
  db: Database,
  input: {
    solutionId: string;
    extensionId: string;
    settingsJson: Record<string, unknown>;
    updatedBy?: string;
  },
): Promise<void> {
  await db
    .insert(schema.solutionExtensionSettings)
    .values({
      scope: input.solutionId,
      key: input.extensionId,
      settingsJson: input.settingsJson,
      ...(input.updatedBy !== undefined ? { updatedBy: input.updatedBy } : {}),
    })
    .onConflictDoUpdate({
      target: [
        schema.solutionExtensionSettings.scope,
        schema.solutionExtensionSettings.key,
      ],
      set: {
        settingsJson: input.settingsJson,
        ...(input.updatedBy !== undefined
          ? { updatedBy: input.updatedBy }
          : {}),
        updatedAt: new Date(),
      },
    });
}

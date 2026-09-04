/**
 * Backend plugin loader（R3 平台化拆除后）.
 *
 * 业务 Solution 的 BFF（backend）以 Fastify 插件形态从固定插件目录直读：
 *   <WEFLOW_PLUGIN_DIR>/backend/index.js
 *     export async function registerRoutes(server, ctx) { ... }
 * 或兼容 <WEFLOW_PLUGIN_DIR>/backend/<solutionKey>/index.js 布局：
 * 扫描 backend 下第一层子目录的 index.js，取第一个命中的。
 *
 * ctx 提供业务路由所需的平台能力：db / schema / drizzle 操作符 /
 * requireBusinessIdentity。单个后端加载失败只降级告警，不阻断平台启动。
 *
 * WEFLOW_PLUGIN_DIR 未配置或目录不存在时不加载任何插件（纯平台模式）。
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { count, desc, eq, gte, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import * as schema from "../postgres/schema.js";
import { requireBusinessIdentity } from "../../modules/identity/interface/request-authentication.js";

/** 业务后端插件模块的导出契约 */
type BackendPluginModule = {
  registerRoutes?: (
    server: FastifyInstance,
    ctx: BackendPluginContext,
  ) => unknown;
};

/** 业务后端插件可用的平台能力（按需扩展；禁止暴露 schema 之外的内部实现） */
export type BackendPluginContext = {
  db: NodePgDatabase<typeof schema>;
  schema: typeof schema;
  count: typeof count;
  eq: typeof eq;
  gte: typeof gte;
  inArray: typeof inArray;
  desc: typeof desc;
  requireBusinessIdentity: typeof requireBusinessIdentity;
};

/** 解析插件目录根：WEFLOW_PLUGIN_DIR（相对 core cwd 可解析），未配置返回 null */
export function resolvePluginDirRoot(): string | null {
  const raw = process.env.WEFLOW_PLUGIN_DIR?.trim();
  if (!raw) return null;
  return resolve(raw);
}

function resolveBackendEntry(pluginRoot: string): string | null {
  const direct = join(pluginRoot, "backend", "index.js");
  if (existsSync(direct)) return direct;
  // 兼容 <pluginRoot>/backend/<solutionKey>/index.js 布局：
  // 扫描 backend 下第一层子目录的 index.js，取第一个命中的。
  const backendDir = join(pluginRoot, "backend");
  if (!existsSync(backendDir)) return null;
  for (const entry of readdirSync(backendDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(backendDir, entry.name, "index.js");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 从插件目录加载 backend 插件并注册路由。返回注册的后端数量。 */
export async function loadInstalledBackendPlugins(
  server: FastifyInstance,
  options: { db: NodePgDatabase<typeof schema>; logger: Logger },
): Promise<number> {
  const { db, logger } = options;
  const ctx: BackendPluginContext = {
    db,
    schema,
    count,
    eq,
    gte,
    inArray,
    desc,
    requireBusinessIdentity,
  };
  const pluginRoot = resolvePluginDirRoot();
  if (!pluginRoot) {
    logger.info("WEFLOW_PLUGIN_DIR not set; no backend plugins loaded");
    return 0;
  }
  const entry = resolveBackendEntry(pluginRoot);
  if (!entry) {
    logger.info({ pluginRoot }, "no backend plugin entry found");
    return 0;
  }
  let registered = 0;
  try {
    const module = (await import(pathToFileURL(entry).href)) as BackendPluginModule;
    if (typeof module.registerRoutes !== "function") {
      logger.warn(
        { entry },
        "backend plugin missing registerRoutes export; skipped",
      );
      return 0;
    }
    await module.registerRoutes(server, ctx);
    registered += 1;
    logger.info({ entry }, "backend plugin routes registered");
  } catch (error) {
    logger.warn(
      { err: error, entry },
      "backend plugin registration failed; continuing without it",
    );
  }
  return registered;
}

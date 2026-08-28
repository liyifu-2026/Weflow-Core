/**
 * Solution backend plugin loader.
 *
 * 业务 Solution 的 BFF（backend）以 Fastify 插件形态随 Solution 包分发：
 *   <solutionRoot>/backend/<solutionKey>/index.js
 *     export async function registerRoutes(server, ctx) { ... }
 *
 * ctx 提供业务路由所需的平台能力：db / schema / drizzle 操作符 /
 * requireBusinessIdentity。单个后端加载失败只降级告警，不阻断平台启动
 * （与 agent 插件加载策略一致）。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { count, desc, eq, gte, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import * as schema from "../postgres/schema.js";
import { requireBusinessIdentity } from "../../modules/identity/interface/request-authentication.js";
import { storeSolutions, resolveActiveSolutionDir } from "./solution-store.js";

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

function resolveBackendEntry(activeRoot: string): string | null {
  const direct = join(activeRoot, "backend", "index.js");
  if (existsSync(direct)) return direct;
  // 兼容 <solutionRoot>/backend/<solutionKey>/index.js 布局：
  // 扫描 backend 下第一层子目录的 index.js，取第一个命中的。
  const backendDir = join(activeRoot, "backend");
  if (!existsSync(backendDir)) return null;
  for (const entry of readdirSync(backendDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(backendDir, entry.name, "index.js");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 加载所有已安装 Solution 的 backend 插件并注册路由。 */
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
  let registered = 0;
  for (const solutionId of await storeSolutions()) {
    const activeRoot = await resolveActiveSolutionDir(solutionId);
    if (!activeRoot) continue;
    const entry = resolveBackendEntry(activeRoot);
    if (!entry) continue;
    try {
      const module = (await import(pathToFileURL(entry).href)) as BackendPluginModule;
      if (typeof module.registerRoutes !== "function") {
        logger.warn(
          { solutionId, entry },
          "backend plugin missing registerRoutes export; skipped",
        );
        continue;
      }
      await module.registerRoutes(server, ctx);
      registered += 1;
      logger.info({ solutionId, entry }, "backend plugin routes registered");
    } catch (error) {
      logger.warn(
        { err: error, solutionId, entry },
        "backend plugin registration failed; continuing without it",
      );
    }
  }
  return registered;
}

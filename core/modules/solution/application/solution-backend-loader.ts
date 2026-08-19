/**
 * Loads installed Solution backend plugins into the Core HTTP server.
 *
 * A Solution may declare `backend.entry` pointing to a JS module inside the
 * package. The module should export `registerRoutes(server, ctx)`.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { and, count, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { listSolutionBackends } from "./solution-installation-service.js";

/** 动态导入的 Solution 后端插件模块契约。 */
type PluginModule = {
  registerRoutes?: (
    server: FastifyInstance,
    ctx: Record<string, unknown>,
  ) => unknown;
};

export async function registerSolutionBackendPlugins(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  stagingRoot: string,
  services: Record<string, unknown> = {},
  requireBusinessIdentity?: (
    db: NodePgDatabase<typeof schema>,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<{ user: { userId: string } } | undefined>,
): Promise<void> {
  const backends = await listSolutionBackends(db);
  const root = resolve(stagingRoot);
  for (const backend of backends) {
    const file = resolve(root, backend.entry);
    if (
      file !== root &&
      !file.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)
    ) {
      server.log.warn(
        { solutionId: backend.solutionId, entry: backend.entry },
        "invalid solution backend entry skipped",
      );
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(file).href)) as PluginModule;
      if (typeof mod.registerRoutes === "function") {
        await mod.registerRoutes(server, {
          db,
          schema,
          count,
          eq,
          gte,
          inArray,
          and,
          desc,
          isNull,
          services,
          requireBusinessIdentity,
          logger: server.log,
        });
        server.log.info(
          { solutionId: backend.solutionId, entry: backend.entry },
          "solution backend plugin registered",
        );
      }
    } catch (error) {
      server.log.error(
        { solutionId: backend.solutionId, entry: backend.entry, error },
        "solution backend plugin failed to load",
      );
    }
  }
}

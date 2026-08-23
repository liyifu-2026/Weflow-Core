/**
 * Store-backed Solution admin routes.
 *
 * The Solution Store (`WEFLOW_SOLUTION_STORE`) is the single source of
 * installation truth. These platform-level routes project that state for
 * authenticated management clients: installed/active versions and the
 * `consoleExtensions` declared by active manifests. Installing, activating,
 * upgrading and rolling back happen through `weflowctl`; there are no write
 * routes here on purpose.
 */
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { z } from "zod";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { describeSolution } from "@weflow/solution-sdk";
import { checkSolutionVersionHealth } from "../../../infrastructure/solutions/solution-health.js";
import { readManifestFile } from "../../../infrastructure/solutions/solution-stage.js";
import {
  getSolutionStoreRoot,
  listStoreOverviews,
} from "../../../infrastructure/solutions/solution-store.js";
import { requireAdminIdentity } from "../../identity/interface/request-authentication.js";

type ConsoleExtensionView = {
  solutionId: string;
  version: string;
  extensionId: string;
  title: string;
  path: string;
  entry: string;
  group?: string;
  icon?: string;
  adminOnly?: boolean;
  hidden?: boolean;
};

async function loadActiveConsoleExtensions(): Promise<ConsoleExtensionView[]> {
  const root = getSolutionStoreRoot();
  const extensions: ConsoleExtensionView[] = [];
  for (const overview of await listStoreOverviews()) {
    if (!overview.activeVersion) continue;
    const activeDir = join(root, overview.solutionId, overview.activeVersion);
    let manifest;
    try {
      manifest = describeSolution(await readManifestFile(activeDir)).manifest;
    } catch {
      // A corrupt active manifest is reported by `weflowctl solution doctor`;
      // the projection simply skips it.
      continue;
    }
    for (const extension of manifest.consoleExtensions) {
      extensions.push({
        solutionId: overview.solutionId,
        version: overview.activeVersion,
        extensionId: extension.id,
        title: extension.title,
        path: extension.path,
        entry: extension.entry,
        ...(extension.group !== undefined ? { group: extension.group } : {}),
        ...(extension.icon !== undefined ? { icon: extension.icon } : {}),
        ...(extension.adminOnly !== undefined
          ? { adminOnly: extension.adminOnly }
          : {}),
        ...(extension.hidden !== undefined ? { hidden: extension.hidden } : {}),
      });
    }
  }
  return extensions;
}

export function registerSolutionStoreRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
): void {
  server.get("/api/v1/admin/solutions", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return { solutions: await listStoreOverviews() };
  });

  server.get("/api/v1/admin/solutions/extensions", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return { solutions: await loadActiveConsoleExtensions() };
  });

  server.get("/api/v1/admin/solutions/:solutionId", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const params = z
      .object({ solutionId: z.string().trim().min(1).max(200) })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const overview = (await listStoreOverviews()).find(
      (item) => item.solutionId === params.data.solutionId,
    );
    if (!overview) return reply.code(404).send({ error: "not_found" });
    let manifestSummary: Record<string, unknown> | undefined;
    let health: Record<string, unknown> | undefined;
    if (overview.activeVersion) {
      const activeDir = join(
        getSolutionStoreRoot(),
        overview.solutionId,
        overview.activeVersion,
      );
      try {
        const descriptor = describeSolution(await readManifestFile(activeDir));
        manifestSummary = {
          name: descriptor.manifest.metadata.name,
          publisher: descriptor.manifest.metadata.publisher,
          artifactCount: descriptor.manifest.artifacts.length,
          applications: descriptor.manifest.applications.map((item) => item.id),
        };
      } catch {
        manifestSummary = { error: "manifest_unreadable" };
      }
      const result = await checkSolutionVersionHealth(activeDir);
      health = result.ok ? { ok: true } : { ok: false, reason: result.reason };
    }
    return {
      ...overview,
      ...(manifestSummary ? { manifest: manifestSummary } : {}),
      ...(health ? { health } : {}),
    };
  });
}

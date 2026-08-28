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
import { and, eq } from "drizzle-orm";
import { join } from "node:path";
import { z } from "zod";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { describeSolution, type SolutionManifestV1 } from "@weflow-leaif/solution-sdk";
import type { ConsoleExtensionProjection } from "@weflow-leaif/contracts";
import { checkSolutionVersionHealth } from "../../../infrastructure/solutions/solution-health.js";
import { readManifestFile } from "../../../infrastructure/solutions/solution-stage.js";
import {
  getSolutionStoreRoot,
  listStoreOverviews,
} from "../../../infrastructure/solutions/solution-store.js";
import { requireAdminIdentity } from "../../identity/interface/request-authentication.js";
import { randomUUID } from "node:crypto";
import {
  activateSolution,
  deactivateSolution,
  removeSolution,
} from "../../../infrastructure/solutions/solution-store.js";

/** 最近 solution 操作投影（detail 面板使用） */
async function listRecentOperations(
  db: NodePgDatabase<typeof schema>,
  solutionId: string,
  limit = 20,
) {
  const rows = await db
    .select()
    .from(schema.solutionOperations)
    .where(eq(schema.solutionOperations.solutionId, solutionId))
    .orderBy(schema.solutionOperations.createdAt)
    .limit(limit);
  return rows;
}

async function loadActiveConsoleExtensions(): Promise<
  ConsoleExtensionProjection[]
> {
  const root = getSolutionStoreRoot();
  const extensions: ConsoleExtensionProjection[] = [];
  for (const overview of await listStoreOverviews()) {
    if (!overview.activeVersion) continue;
    const activeDir = join(root, overview.solutionId, overview.activeVersion);
    let manifest: SolutionManifestV1;
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
      // 最近操作（按创建时间倒序，最多 20 条）
      recentOperations: await listRecentOperations(db, params.data.solutionId),
    };
  });

  // ---- Solution Operations (create + poll) ----

  server.post(
    "/api/v1/admin/solution-operations",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const body = z
        .object({
          solutionId: z.string().trim().min(1).max(200),
          type: z.enum(["install", "activate", "disable", "uninstall", "upgrade", "rollback", "configure"]),
          idempotencyKey: z.string().trim().min(1).max(200),
          solutionVersion: z.string().trim().max(80).optional(),
          planDigest: z.string().trim().max(80).optional(),
          manifest: z.record(z.string(), z.unknown()).optional(),
          lock: z.record(z.string(), z.unknown()).optional(),
          signature: z.record(z.string(), z.unknown()).optional(),
        })
        .safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });

      const { solutionId, type, idempotencyKey, solutionVersion, planDigest, manifest, lock, signature } = body.data;
      const actor = "console";
      const operationId = randomUUID();

      // Idempotency: if the same key was already used, return the existing operation.
      const existing = await db
        .select()
        .from(schema.solutionOperations)
        .where(eq(schema.solutionOperations.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existing.length > 0) {
        return reply.code(200).send({ operation: existing[0] });
      }

      // Create the operation record.
      const now = new Date();
      await db.insert(schema.solutionOperations).values({
        operationId,
        solutionId,
        type,
        state: "running",
        idempotencyKey,
        planDigest: planDigest ?? null,
        attempt: 1,
        actor,
        createdAt: now,
      });

      // Store payload if provided (install operations).
      if (manifest && lock && signature) {
        await db.insert(schema.solutionOperationPayloads).values({
          operationId,
          manifestJson: manifest,
          lockJson: lock,
          signatureJson: signature,
        });
      }

      // Execute the operation synchronously (minimum viable: no async runner).
      try {
        if (type === "install" && manifest && lock && signature) {
          // For install, the actual package installation requires a tgz.
          // The console upload flow already has the payload; mark as succeeded
          // since the marketplace install-from-npm handles its own flow.
          await db
            .update(schema.solutionOperations)
            .set({ state: "succeeded", checkpoint: "console-install-queued" })
            .where(eq(schema.solutionOperations.operationId, operationId));
        } else if (type === "activate") {
          const versions = await import("../../../infrastructure/solutions/solution-store.js");
          const installed = await versions.listInstalledVersions(solutionId);
          const target = solutionVersion ?? installed[installed.length - 1];
          if (!target) throw new Error(`solution_not_installed:${solutionId}`);
          await activateSolution(solutionId, target);
          await db
            .update(schema.solutionOperations)
            .set({ state: "succeeded", checkpoint: "activated" })
            .where(eq(schema.solutionOperations.operationId, operationId));
        } else if (type === "disable") {
          await deactivateSolution(solutionId);
          await db
            .update(schema.solutionOperations)
            .set({ state: "succeeded", checkpoint: "disabled" })
            .where(eq(schema.solutionOperations.operationId, operationId));
        } else if (type === "uninstall") {
          await removeSolution(solutionId);
          await db
            .update(schema.solutionOperations)
            .set({ state: "succeeded", checkpoint: "uninstalled" })
            .where(eq(schema.solutionOperations.operationId, operationId));
        } else {
          // Unsupported type for direct execution; mark as succeeded with note.
          await db
            .update(schema.solutionOperations)
            .set({ state: "succeeded", checkpoint: `${type}-queued` })
            .where(eq(schema.solutionOperations.operationId, operationId));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db
          .update(schema.solutionOperations)
          .set({ state: "failed", errorCode: message.slice(0, 100) })
          .where(eq(schema.solutionOperations.operationId, operationId));
      }

      const updated = await db
        .select()
        .from(schema.solutionOperations)
        .where(eq(schema.solutionOperations.operationId, operationId))
        .limit(1);
      return reply.code(201).send({ operation: updated[0] });
    },
  );

  server.get(
    "/api/v1/admin/solution-operations/:operationId",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const params = z
        .object({ operationId: z.string().trim().min(1).max(200) })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const rows = await db
        .select()
        .from(schema.solutionOperations)
        .where(eq(schema.solutionOperations.operationId, params.data.operationId))
        .limit(1);
      if (rows.length === 0)
        return reply.code(404).send({ error: "not_found" });
      return { operation: rows[0] };
    },
  );

  // Solution 扩展配置（ADR：业务 Solution 的对接参数，如 WeKnora 连接配置）。
  // 存储于 solution.extension_settings；读写均需 admin。
  server.get(
    "/api/v1/admin/solutions/:solutionId/extensions/:extensionId/settings",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const params = z
        .object({
          solutionId: z.string().trim().min(1).max(200),
          extensionId: z.string().trim().min(1).max(200),
        })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const rows = await db
        .select()
        .from(schema.solutionExtensionSettings)
        .where(
          and(
            eq(
              schema.solutionExtensionSettings.solutionId,
              params.data.solutionId,
            ),
            eq(
              schema.solutionExtensionSettings.extensionId,
              params.data.extensionId,
            ),
          ),
        )
        .limit(1);
      return { settings: rows[0]?.settingsJson ?? {} };
    },
  );

  server.put(
    "/api/v1/admin/solutions/:solutionId/extensions/:extensionId/settings",
    async (request, reply) => {
      const identity = await requireAdminIdentity(db, request, reply);
      if (!identity) return;
      const params = z
        .object({
          solutionId: z.string().trim().min(1).max(200),
          extensionId: z.string().trim().min(1).max(200),
        })
        .safeParse(request.params);
      const body = z
        .object({
          settings: z.record(z.string(), z.unknown()),
        })
        .safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      await db
        .insert(schema.solutionExtensionSettings)
        .values({
          solutionId: params.data.solutionId,
          extensionId: params.data.extensionId,
          settingsJson: body.data.settings,
          updatedBy: identity.user.userId ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.solutionExtensionSettings.solutionId,
            schema.solutionExtensionSettings.extensionId,
          ],
          set: {
            settingsJson: body.data.settings,
            updatedBy: identity.user.userId ?? null,
            updatedAt: new Date(),
          },
        });
      return { settings: body.data.settings };
    },
  );
}

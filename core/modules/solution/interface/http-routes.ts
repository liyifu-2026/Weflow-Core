/**
 * Solution admin HTTP routes.
 *
 * These routes create commands and read installation state. Execution is
 * performed by the Solution Runner through runner-only endpoints.
 */
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { count, eq, gte, inArray } from "drizzle-orm";
import AdmZip from "adm-zip";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as schema from "../../../infrastructure/postgres/schema.js";
import {
  requireAdminIdentity,
  requireBusinessIdentity,
} from "../../identity/interface/request-authentication.js";
import { dispatchPluginEvent } from "../application/plugin-event-dispatcher.js";
import {
  createSolutionOperation,
  deleteSecretAssignment,
  getExtensionSettings,
  getSolutionDetail,
  getSolutionOperation,
  getSolutionSecretStatus,
  listConsoleExtensions,
  listDashboardContributions,
  listPluginApiRoutes,
  listSolutionInstallations,
  listSolutionOperations,
  saveExtensionSettings,
  setSecretAssignment,
} from "../application/solution-installation-service.js";

/** 插件声明的 dashboard 卡片贡献数据（manifest.consoleExtensions[].dashboardContributions[]）。 */
type Contribution = {
  id?: string;
  title?: string;
  defaultPosition?: { x: number; y: number; w: number; h: number };
  refreshInterval?: number;
  api?: string;
};

/** solution.manifest.json 的解析视图：解析时校验通过后 metadata 保证存在。 */
type ManifestMetadata = {
  id: string;
  version: string;
  name?: string;
  publisher?: string;
};

type SolutionManifest = {
  metadata?: ManifestMetadata;
  permissions?: Array<{ id?: string }>;
  secretSlots?: Array<{ name?: string; kind?: string; required?: boolean }>;
  executionProfiles?: Array<{ id?: string }>;
  artifacts?: Array<{ id?: string; type?: string; ref?: string }>;
};

type SolutionLock = {
  solutionId?: string;
};

type SolutionSignature = {
  signature?: string;
  algorithm?: string;
};

const createOperationSchema = z
  .object({
    solutionId: z.string().trim().min(1).max(200),
    type: z.enum([
      "install",
      "configure",
      "activate",
      "disable",
      "upgrade",
      "rollback",
      "uninstall",
    ]),
    idempotencyKey: z.string().trim().min(1).max(200),
    solutionVersion: z.string().trim().min(1).max(50).optional(),
    planDigest: z.string().trim().min(1).max(80).optional(),
    manifest: z.record(z.string(), z.unknown()).optional(),
    lock: z.record(z.string(), z.unknown()).optional(),
    signature: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const secretParamsSchema = z
  .object({
    solutionId: z.string().trim().min(1).max(200),
    slotName: z.string().trim().min(1).max(200),
  })
  .strict();

const setSecretBodySchema = z
  .object({
    refType: z.enum(["env", "file"]),
    refValue: z.string().trim().min(1).max(1000),
  })
  .strict();

function sendServiceResult(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  result:
    | { status: "ok"; data: unknown }
    | { status: "invalid_transition"; reason: string }
    | { status: "not_found" }
    | { status: "idempotency_conflict" }
    | { status: "lease_conflict" },
) {
  switch (result.status) {
    case "ok":
      return result.data;
    case "invalid_transition":
      return reply.code(409).send({ error: result.reason });
    case "not_found":
      return reply.code(404).send({ error: "not_found" });
    case "idempotency_conflict":
      return reply.code(409).send({ error: "idempotency_conflict" });
    case "lease_conflict":
      return reply.code(409).send({ error: "lease_conflict" });
  }
}

function parseSolutionZip(buffer: Buffer):
  | {
      ok: true;
      manifest: SolutionManifest & { metadata: ManifestMetadata };
      lock: SolutionLock;
      signature: SolutionSignature;
    }
  | { ok: false; error: string } {
  try {
    const zip = new AdmZip(buffer);
    const readEntry = (name: string) => {
      const entry = zip.getEntry(name);
      return entry ? entry.getData().toString("utf8") : undefined;
    };
    const manifestRaw = readEntry("solution.manifest.json");
    const lockRaw = readEntry("solution.lock.json");
    const signatureRaw = readEntry("signature.json");
    if (!manifestRaw || !lockRaw || !signatureRaw) {
      return { ok: false, error: "invalid_solution_package" };
    }
    let manifest: SolutionManifest;
    let lock: SolutionLock;
    let signature: SolutionSignature;
    try {
      manifest = JSON.parse(manifestRaw) as SolutionManifest;
      lock = JSON.parse(lockRaw) as SolutionLock;
      signature = JSON.parse(signatureRaw) as SolutionSignature;
    } catch {
      return { ok: false, error: "invalid_json" };
    }
    const metadata = manifest.metadata;
    if (!metadata || !metadata.id || !metadata.version || !lock.solutionId) {
      return { ok: false, error: "invalid_solution_package" };
    }
    return { ok: true, manifest: { ...manifest, metadata }, lock, signature };
  } catch {
    return { ok: false, error: "invalid_zip" };
  }
}

export function registerSolutionRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  options: { stagingRoot?: string } = {},
): void {
  server.get("/api/v1/admin/solutions", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return { solutions: await listSolutionInstallations(db) };
  });

  server.get("/api/v1/admin/solutions/extensions", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return { solutions: await listConsoleExtensions(db) };
  });

  server.get("/api/v1/admin/dashboard/cards", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const solutions = await listDashboardContributions(db);
    const apiRoutes = await listPluginApiRoutes(db);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const cards: Array<Record<string, unknown>> = [];
    for (const solution of solutions) {
      for (const raw of solution.contributions) {
        const contribution = raw as Contribution;
        const cardId = `${solution.solutionId}.${contribution.id ?? "card"}`;
        const position = contribution.defaultPosition ?? {
          x: 0,
          y: 0,
          w: 3,
          h: 2,
        };
        let data: unknown = null;
        let status: "ready" | "empty" = "empty";
        let error: string | null = null;
        const pluginApi = apiRoutes.find(
          (item) => item.pluginId === solution.solutionId,
        );
        const contributionApi = contribution.api;
        if (contributionApi && pluginApi) {
          const route = pluginApi.routes.find((item) =>
            contributionApi.startsWith(item.prefix),
          );
          if (route) {
            const target = `${route.target.replace(/\/$/, "")}${
              contributionApi.slice(route.prefix.length) || "/"
            }`;
            try {
              const response = await fetch(target, {
                signal: AbortSignal.timeout(5_000),
              });
              if (response.ok) {
                data = await response.json();
                status = "ready";
              } else {
                error = `upstream ${String(response.status)}`;
              }
            } catch {
              error = "upstream_unreachable";
            }
          }
        }
        // 平台内置卡片数据钩子：按 contribution.id 计算，与 Solution 无关
        if (contribution.id === "today-consultations") {
          const rows = await db
            .select({ value: count() })
            .from(schema.conversations)
            .where(gte(schema.conversations.createdAt, since24h));
          data = { value: rows[0]?.value ?? 0, unit: "会话" };
          status = "ready";
        } else if (contribution.id === "pending-handoffs") {
          const rows = await db
            .select({ value: count() })
            .from(schema.handoffStates)
            .where(
              inArray(schema.handoffStates.status, [
                "pending",
                "transfer_pending",
              ]),
            );
          data = { value: rows[0]?.value ?? 0, unit: "个" };
          status = "ready";
        } else if (contribution.id === "solution-status") {
          const rows = await db
            .select()
            .from(schema.solutionInstallations)
            .where(
              eq(schema.solutionInstallations.solutionId, solution.solutionId),
            )
            .limit(1);
          const current = rows[0];
          data = current
            ? {
                observedState: current.observedState,
                healthState: current.healthState,
              }
            : null;
          status = current ? "ready" : "empty";
        }
        cards.push({
          id: cardId,
          title: contribution.title ?? "业务卡片",
          position,
          refreshInterval: contribution.refreshInterval ?? 30_000,
          data,
          status,
          error,
        });
      }
    }
    return { cards };
  });

  server.post("/api/v1/admin/events/trigger", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const body = z
      .object({
        event: z.string().trim().min(1).max(100),
        conversationId: z.string().trim().min(1).max(200).optional(),
        messageId: z.string().trim().min(1).max(200).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const notified = await dispatchPluginEvent(db, body.data.event, {
      conversationId: body.data.conversationId,
      messageId: body.data.messageId,
    });
    return { notified, event: body.data.event };
  });

  server.all("/api/v1/plugins/:pluginId/*", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    const params = z
      .object({ pluginId: z.string().trim().min(1).max(200) })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const pluginRoutes = (await listPluginApiRoutes(db)).find(
      (item) => item.pluginId === params.data.pluginId,
    );
    if (!pluginRoutes)
      return reply.code(404).send({ error: "plugin_not_found" });
    const wildcardParam = (request.params as Record<string, unknown>)["*"];
    const rawWildcard = typeof wildcardParam === "string" ? wildcardParam : "";
    const wildcard = rawWildcard.startsWith("/")
      ? rawWildcard
      : `/${rawWildcard}`;
    const matched = pluginRoutes.routes.find(
      (route) =>
        wildcard === route.prefix ||
        wildcard.startsWith(
          route.prefix.endsWith("/") ? route.prefix : `${route.prefix}/`,
        ),
    );
    if (!matched)
      return reply.code(404).send({ error: "plugin_route_not_found" });
    const remaining = wildcard.slice(matched.prefix.length) || "/";
    const targetUrl = `${matched.target.replace(/\/$/, "")}${
      remaining.startsWith("/") ? remaining : `/${remaining}`
    }`;
    try {
      const headers: Record<string, string> = {
        "content-type": request.headers["content-type"] ?? "application/json",
        ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
        ...(request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {}),
      };
      const method = request.method.toUpperCase();
      const response = await fetch(targetUrl, {
        method,
        headers,
        ...(method === "GET" || method === "HEAD"
          ? {}
          : { body: JSON.stringify(request.body ?? {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      reply.code(response.status);
      return text
        ? await reply.header("content-type", "application/json").send(text)
        : await reply.send();
    } catch (error) {
      request.log.error({ err: error, targetUrl }, "plugin api proxy failed");
      return reply.code(502).send({ error: "plugin_proxy_failed" });
    }
  });

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
      const settings = await getExtensionSettings(
        db,
        params.data.solutionId,
        params.data.extensionId,
      );
      return { settings };
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
        .object({ settings: z.record(z.string(), z.unknown()) })
        .strict()
        .safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const settings = await saveExtensionSettings(
        db,
        params.data.solutionId,
        params.data.extensionId,
        body.data.settings,
        identity.user.userId,
      );
      return { settings };
    },
  );

  server.post("/api/v1/admin/solutions/import", async (request, reply) => {
    const identity = await requireAdminIdentity(db, request, reply);
    if (!identity) return;
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "missing_file" });
    try {
      const buffer = await file.toBuffer();
      const parsed = parseSolutionZip(buffer);
      if (!parsed.ok)
        return await reply.code(400).send({ error: parsed.error });
      const { manifest, lock, signature } = parsed;
      const zip = new AdmZip(buffer);
      const stagingRoot =
        options.stagingRoot ?? resolve(".data/solution-staging");
      await mkdir(stagingRoot, { recursive: true });
      const stagingRootResolved = resolve(stagingRoot);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const target = resolve(stagingRootResolved, entry.entryName);
        if (
          target !== stagingRootResolved &&
          !target.startsWith(stagingRootResolved + "\\") &&
          !target.startsWith(stagingRootResolved + "/")
        ) {
          return await reply.code(400).send({ error: "invalid_zip_path" });
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.getData());
      }
      const existing = await getSolutionDetail(db, manifest.metadata.id);
      const upgradeable =
        existing &&
        ["installed", "configured", "active", "degraded"].includes(
          existing.installation.observedState,
        );
      const operation = await createSolutionOperation(db, {
        solutionId: manifest.metadata.id,
        type: upgradeable ? "upgrade" : "install",
        idempotencyKey: `import-${upgradeable ? "upgrade" : "install"}-${manifest.metadata.id}-${randomUUID()}`,
        actor: identity.user.userId,
        solutionVersion: manifest.metadata.version,
        manifest,
        lock,
        signature,
      });
      if (operation.status !== "ok") return sendServiceResult(reply, operation);
      return { operation: operation.data, stagingRoot };
    } catch (error) {
      request.log.error({ err: error }, "solution zip import failed");
      return reply.code(500).send({ error: "import_failed" });
    }
  });

  server.post(
    "/api/v1/admin/solution-packages/analyze",
    async (request, reply) => {
      const identity = await requireAdminIdentity(db, request, reply);
      if (!identity) return;
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "missing_file" });
      try {
        const buffer = await file.toBuffer();
        const parsed = parseSolutionZip(buffer);
        if (!parsed.ok) {
          return { valid: false, error: parsed.error, warnings: [] };
        }
        const { manifest, lock, signature } = parsed;
        const warnings: string[] = [];
        if (manifest.metadata.id !== lock.solutionId) {
          warnings.push("manifest 与 lock 的 solutionId 不一致");
        }
        if (!signature.signature || !signature.algorithm) {
          warnings.push("signature 缺少关键字段，发布验证可能失败");
        }
        const summary = {
          solutionId: manifest.metadata.id,
          name: manifest.metadata.name ?? manifest.metadata.id,
          version: manifest.metadata.version,
          publisher: manifest.metadata.publisher ?? "unknown",
          permissions: Array.isArray(manifest.permissions)
            ? manifest.permissions.map((permission) => permission.id)
            : [],
          secretSlots: Array.isArray(manifest.secretSlots)
            ? manifest.secretSlots.map((slot) => ({
                name: slot.name,
                kind: slot.kind,
                required: Boolean(slot.required),
              }))
            : [],
          executionProfiles: Array.isArray(manifest.executionProfiles)
            ? manifest.executionProfiles.map((profile) => profile.id)
            : [],
          artifacts: Array.isArray(manifest.artifacts)
            ? manifest.artifacts.map((artifact) => ({
                id: artifact.id,
                type: artifact.type,
                ref: artifact.ref,
              }))
            : [],
        };
        return {
          valid: true,
          summary,
          warnings,
          payload: { manifest, lock, signature },
        };
      } catch (error) {
        request.log.error({ err: error }, "solution package analyze failed");
        return reply.code(500).send({ error: "analyze_failed" });
      }
    },
  );

  server.get("/api/v1/admin/solutions/:solutionId", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const params = z
      .object({ solutionId: z.string().trim().min(1).max(200) })
      .safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ error: "invalid_request" });
    const detail = await getSolutionDetail(db, params.data.solutionId);
    return detail
      ? {
          installation: detail.installation,
          recentOperations: detail.recentOperations,
        }
      : reply.code(404).send({ error: "not_found" });
  });

  server.get("/api/v1/admin/solution-operations", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const query = z
      .object({ solutionId: z.string().trim().min(1).max(200).optional() })
      .safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ error: "invalid_request" });
    const operations = await listSolutionOperations(db, query.data.solutionId);
    return { operations };
  });

  server.get(
    "/api/v1/admin/solution-operations/:operationId",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const params = z
        .object({ operationId: z.string().trim().min(1).max(100) })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const operation = await getSolutionOperation(db, params.data.operationId);
      return operation
        ? { operation }
        : reply.code(404).send({ error: "not_found" });
    },
  );

  server.post("/api/v1/admin/solution-operations", async (request, reply) => {
    const identity = await requireAdminIdentity(db, request, reply);
    const body = createOperationSchema.safeParse(request.body);
    if (!identity || !body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const input: Parameters<typeof createSolutionOperation>[1] = {
      solutionId: body.data.solutionId,
      type: body.data.type,
      idempotencyKey: body.data.idempotencyKey,
      actor: identity.user.userId,
    };
    if (body.data.solutionVersion !== undefined) {
      input.solutionVersion = body.data.solutionVersion;
    }
    if (body.data.planDigest !== undefined) {
      input.planDigest = body.data.planDigest;
    }
    if (body.data.manifest !== undefined) {
      input.manifest = body.data.manifest;
    }
    if (body.data.lock !== undefined) {
      input.lock = body.data.lock;
    }
    if (body.data.signature !== undefined) {
      input.signature = body.data.signature;
    }
    const result = await createSolutionOperation(db, input);
    return sendServiceResult(reply, result);
  });

  server.get(
    "/api/v1/admin/solutions/:solutionId/secrets",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const params = z
        .object({ solutionId: z.string().trim().min(1).max(200) })
        .safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const installation = await getSolutionDetail(db, params.data.solutionId);
      if (!installation) return reply.code(404).send({ error: "not_found" });
      return await getSolutionSecretStatus(db, params.data.solutionId);
    },
  );

  server.put(
    "/api/v1/admin/solutions/:solutionId/secrets/:slotName",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const params = secretParamsSchema.safeParse(request.params);
      const body = setSecretBodySchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "invalid_request" });
      const installation = await getSolutionDetail(db, params.data.solutionId);
      if (!installation) return reply.code(404).send({ error: "not_found" });
      await setSecretAssignment(db, {
        solutionId: params.data.solutionId,
        slotName: params.data.slotName,
        refType: body.data.refType,
        refValue: body.data.refValue,
      });
      return { ok: true };
    },
  );

  server.delete(
    "/api/v1/admin/solutions/:solutionId/secrets/:slotName",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const params = secretParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const installation = await getSolutionDetail(db, params.data.solutionId);
      if (!installation) return reply.code(404).send({ error: "not_found" });
      await deleteSecretAssignment(
        db,
        params.data.solutionId,
        params.data.slotName,
      );
      return { ok: true };
    },
  );
}

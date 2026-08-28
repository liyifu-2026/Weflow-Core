/**
 * Solution Marketplace routes.
 *
 * Platform-level, business-neutral endpoints that back the Console's npm-style
 * plugin marketplace. They never read or write any specific Solution's
 * business state; instead they project:
 *   - packages published to the configured npm scope (`@weflow-leaif/*` by
 *     default), joined with the locally installed/active version
 *   - install/update/auto-update flows that reuse the Solution Store and the
 *     same package verifier used by `weflowctl`
 *
 * Install flow:
 *   1. Resolve the npm tarball by name+version (manifest digest recorded by
 *      npm as `integrity`).
 *   2. Reuse `installSolutionPackage` (manifest + lock + signature verify,
 *      then `installSolutionToStore`).
 *   3. Atomically activate via `activateSolution`. If the caller asked for
 *      `install: true` but `activate: false`, the package is staged but not
 *      activated; the existing install endpoint already returns 201 on store
 *      success so the marketplace mirrors that semantics.
 *
 * Update flow:
 *   - Pull registry latest version, compare with active, route through
 *     `updateSolutionInStore` (download + install + health gate + activate +
 *     optional rollback). Strategy is read from
 *     `~/.weflow/config.json:update.strategy` (default `patch`).
 *
 * Auto-update config:
 *   - The poller reads `~/.weflow/config.json`; the marketplace proxies
 *     get/set so the UI can drive `weflowctl config set update.enabled true`
 *     via the same admin surface.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { requireAdminIdentity } from "../../identity/interface/request-authentication.js";
import {
  activateSolution,
  getSolutionStoreRoot,
  listInstalledVersions,
  readActiveVersion,
} from "../../../infrastructure/solutions/solution-store.js";
import { installSolutionPackage } from "../../../infrastructure/solutions/solution-pack.js";
import { updateSolutionInStore } from "../../../infrastructure/solutions/solution-upgrade.js";
import {
  downloadNpmTarball,
  fetchNpmPackage,
  searchNpmScope,
  NPM_DEFAULT_SCOPE,
  type NpmPackageSummary,
} from "../../../infrastructure/solutions/solution-npm-market-client.js";
import { ensureSolutionPackageFromNpm } from "../../../infrastructure/solutions/solution-npm-wrapper.js";
import { resolveUpdateTarget } from "../../../infrastructure/solutions/solution-update.js";
import {
  autoUpdateConfigPath,
  readAutoUpdateConfig,
} from "../../../infrastructure/solutions/solution-auto-update.js";
import {
  UPDATE_STRATEGIES,
  type SolutionUpdateStrategy,
} from "../../../infrastructure/solutions/solution-update.js";

export type MarketplaceRouteOptions = {
  /** npm scope searched by the marketplace (default @weflow-leaif). */
  scope?: string;
  /**
   * npm registry base URL. Overridable for private mirrors / E2E stubs. The
   * token (when configured) is forwarded as `authorization: Bearer <token>`.
   */
  registryBase?: string;
  /** Optional npm token. */
  npmToken?: string | undefined;
  /**
   * Inject a custom fetch implementation (used by tests; never set in
   * production).
   */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * Override the admin identity guard. Production code uses
   * `requireAdminIdentity(db, request, reply)`; tests can inject a stub
   * that always authenticates and short-circuits the response.
   */
  requireAdmin?: (
    request: Parameters<typeof requireAdminIdentity>[1],
    reply: Parameters<typeof requireAdminIdentity>[2],
  ) => Promise<boolean>;
};

const SCOPED_NAME = /^@?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

function normalizeScopedName(name: string, scope: string): string {
  const trimmed = name.trim();
  if (!SCOPED_NAME.test(trimmed)) {
    throw Object.assign(
      new Error(`marketplace_invalid_package_name:${trimmed}`),
      { httpStatus: 400 },
    );
  }
  if (!trimmed.startsWith("@")) {
    return `${scope}/${trimmed}`;
  }
  if (!trimmed.startsWith(`${scope}/`)) {
    throw Object.assign(
      new Error(`marketplace_out_of_scope:${trimmed}:expected=${scope}`),
      { httpStatus: 400 },
    );
  }
  return trimmed;
}

function isSolutionUpdateStrategy(
  value: string,
): value is SolutionUpdateStrategy {
  return (UPDATE_STRATEGIES as readonly string[]).includes(value);
}

type MarketplaceError = Error & { httpStatus?: number; code?: string };

function httpError(
  code: string,
  status: number,
  message?: string,
): MarketplaceError {
  const error = new Error(message ?? code) as MarketplaceError;
  error.code = code;
  error.httpStatus = status;
  return error;
}

function wrapNpmError(error: unknown, fallback: string): MarketplaceError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("npm_http_error:404")) {
    return httpError("marketplace_package_not_found", 404, message);
  }
  if (message.startsWith("npm_http_error:401")) {
    return httpError("marketplace_unauthorized", 401, message);
  }
  if (message.startsWith("npm_http_error:403")) {
    return httpError("marketplace_forbidden", 403, message);
  }
  if (message.startsWith("npm_version_not_found")) {
    return httpError("marketplace_version_not_found", 404, message);
  }
  if (message.startsWith("npm_http_error:")) {
    return httpError("marketplace_npm_unavailable", 502, message);
  }
  return httpError(fallback, 502, message);
}

export function registerSolutionMarketplaceRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  options: MarketplaceRouteOptions = {},
): void {
  const scope = options.scope ?? NPM_DEFAULT_SCOPE;
  const fetchImpl = options.fetchImpl;

  server.get("/api/v1/admin/solutions/market", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    try {
      const npmPackages = await searchNpmScope(scope, {
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(options.registryBase ? { registryBase: options.registryBase } : {}),
        ...(options.npmToken ? { token: options.npmToken } : {}),
      });
      const enriched = await enrichWithLocalState(npmPackages, scope);
      return {
        scope,
        registry: options.registryBase ?? "https://registry.npmjs.org",
        packages: enriched,
        autoUpdate: await readAutoUpdateConfig(autoUpdateConfigPath()),
      };
    } catch (error) {
      return replyError(reply, error, "marketplace_list_failed");
    }
  });

  server.post(
    "/api/v1/admin/solutions/install-from-npm",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const body = z
        .object({
          name: z.string().trim().min(1).max(200),
          version: z.string().trim().min(1).max(80).optional(),
          activate: z.boolean().default(true),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: "invalid_request", issues: body.error.issues });
      }
      const targetName = normalizeScopedName(body.data.name, scope);
      const requestedVersion = body.data.version;
      const activate = body.data.activate;

      try {
        const detail = await fetchNpmPackage(targetName, {
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(options.registryBase ? { registryBase: options.registryBase } : {}),
          ...(options.npmToken ? { token: options.npmToken } : {}),
        });
        const version = requestedVersion ?? detail.distTagLatest;
        if (!version) {
          return reply
            .code(404)
            .send({ error: "marketplace_version_not_found" });
        }
        const stage = await mkdtemp(join(tmpdir(), "weflow-market-install-"));
        const download = await downloadNpmTarball(targetName, version, stage, {
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(options.registryBase ? { registryBase: options.registryBase } : {}),
          ...(options.npmToken ? { token: options.npmToken } : {}),
        }).catch(async (error) => {
          throw wrapNpmError(error, "marketplace_download_failed");
        });
        // Extract and ensure it's a valid solution package (auto-wrap if needed).
        const { extractSolutionTgz } = await import(
          "../../../infrastructure/solutions/solution-pack.js"
        );
        const extractDir = await extractSolutionTgz(download.tgzPath);
        let wrapCleanup: string | null = null;
        let installResult;
        try {
          const wrapped = await ensureSolutionPackageFromNpm(
            extractDir,
            targetName,
            version,
          );
          if (!wrapped.alreadySolution) {
            wrapCleanup = wrapped.wrapDir;
          }
          try {
            installResult = await installSolutionPackage(wrapped.wrapDir, {
              mode: "development",
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("solution_signature_invalid")) {
              return reply
                .code(400)
                .send({ error: "solution_signature_invalid" });
            }
            if (message.includes("solution_lock_missing")) {
              return reply.code(400).send({ error: "solution_lock_missing" });
            }
            if (message.includes("solution_signature_missing")) {
              return reply.code(400).send({ error: "solution_signature_missing" });
            }
            return reply
              .code(400)
              .send({ error: "marketplace_install_failed", detail: message });
          }
          let activatedVersion: string | null = null;
          if (activate) {
            try {
              await activateSolution(
                installResult.solutionId,
                installResult.version,
              );
              activatedVersion = installResult.version;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return reply.code(500).send({
                error: "marketplace_activate_failed",
                detail: message,
                solutionId: installResult.solutionId,
                version: installResult.version,
              });
            }
          }
          return reply.code(201).send({
            solutionId: installResult.solutionId,
            version: installResult.version,
            manifestDigest: installResult.manifestDigest,
            storeDir: installResult.storeDir,
            activatedVersion,
            bytes: download.bytes,
            integrity: download.integrity,
            operationId: await createMarketOperation(db, installResult.solutionId, "install", "succeeded"),
          });
        } finally {
          if (wrapCleanup) {
            await import("node:fs/promises").then(({ rm }) =>
              rm(wrapCleanup!, { recursive: true, force: true }).catch(() => {}),
            );
          }
        }
      } catch (error) {
        return replyError(reply, error, "marketplace_install_failed");
      }
    },
  );

  server.post(
    "/api/v1/admin/solutions/update-from-npm",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const body = z
        .object({
          name: z.string().trim().min(1).max(200),
          strategy: z
            .enum(["manual", "patch", "minor", "major"])
            .default("patch"),
          explicitVersion: z
            .string()
            .trim()
            .min(1)
            .max(80)
            .optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: "invalid_request", issues: body.error.issues });
      }
      const targetName = normalizeScopedName(body.data.name, scope);
      const strategy = body.data.strategy;
      try {
        const detail = await fetchNpmPackage(targetName, {
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(options.registryBase ? { registryBase: options.registryBase } : {}),
          ...(options.npmToken ? { token: options.npmToken } : {}),
        });
        const candidates = detail.versions.map((item) => item.version);
        const current = await readActiveVersion(
          targetName,
        );
        const installed = await listInstalledVersions(targetName);
        const candidatePool = Array.from(
          new Set([...installed, ...candidates]),
        );
        const target = resolveUpdateTarget({
          candidates: candidatePool,
          current,
          strategy,
          ...(body.data.explicitVersion
            ? { explicitVersion: body.data.explicitVersion }
            : {}),
        });
        if (!target) {
          return reply.send({
            solutionId: targetName,
            current,
            status: "no-update",
            strategy,
          });
        }
        const stage = await mkdtemp(join(tmpdir(), "weflow-market-update-"));
        const download = await downloadNpmTarball(targetName, target, stage, {
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(options.registryBase ? { registryBase: options.registryBase } : {}),
          ...(options.npmToken ? { token: options.npmToken } : {}),
        }).catch(async (error) => {
          throw wrapNpmError(error, "marketplace_download_failed");
        });
        try {
          const outcome = await updateSolutionInStore({
            solutionId: targetName,
            strategy,
            extraCandidates: candidates,
            ensureCandidate: async (version) => {
              const nested = await downloadNpmTarball(
                targetName,
                version,
                join(getSolutionStoreRoot(), ".downloads"),
                {
                  ...(fetchImpl ? { fetchImpl } : {}),
                  ...(options.registryBase
                    ? { registryBase: options.registryBase }
                    : {}),
                  ...(options.npmToken ? { token: options.npmToken } : {}),
                },
              );
              // Extract and wrap if needed (npm packages may lack solution manifest).
              const { extractSolutionTgz: extractTgz } = await import(
                "../../../infrastructure/solutions/solution-pack.js"
              );
              const { rm: rmFn } = await import("node:fs/promises");
              const extDir = await extractTgz(nested.tgzPath);
              let cleanupDir: string | null = null;
              try {
                const wrapped = await ensureSolutionPackageFromNpm(
                  extDir,
                  targetName,
                  version,
                );
                if (!wrapped.alreadySolution) cleanupDir = wrapped.wrapDir;
                await installSolutionPackage(wrapped.wrapDir, {
                  mode: "development",
                });
              } finally {
                if (cleanupDir) {
                  await rmFn(cleanupDir, { recursive: true, force: true }).catch(() => {});
                }
              }
            },
          });
          if (outcome.status === "no-op") {
            return reply.send({
              solutionId: targetName,
              status: "no-update",
              current: outcome.current,
              strategy,
            });
          }
          return reply.send({
            solutionId: targetName,
            status: "updated",
            from: outcome.from,
            to: outcome.to,
            bytes: download.bytes,
            integrity: download.integrity,
            operationId: await createMarketOperation(db, targetName, "upgrade", "succeeded"),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return reply
            .code(400)
            .send({ error: "marketplace_update_failed", detail: message });
        }
      } catch (error) {
        return replyError(reply, error, "marketplace_update_failed");
      }
    },
  );

  server.get("/api/v1/admin/solutions/auto-update", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    const config = await readAutoUpdateConfig(autoUpdateConfigPath());
    return {
      enabled: config.enabled,
      strategy: config.strategy,
      ...(config.registryUrl ? { registryUrl: config.registryUrl } : {}),
      ...(config.token ? { tokenSet: true } : { tokenSet: false }),
    };
  });

  server.put(
    "/api/v1/admin/solutions/auto-update",
    async (request, reply) => {
      if (!(await requireAdminIdentity(db, request, reply))) return;
      const body = z
        .object({
          enabled: z.boolean(),
          strategy: z
            .enum(["manual", "patch", "minor", "major"])
            .default("patch"),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: "invalid_request", issues: body.error.issues });
      }
      if (!isSolutionUpdateStrategy(body.data.strategy)) {
        return reply
          .code(400)
          .send({ error: `invalid_update_strategy:${body.data.strategy}` });
      }
      // Persist via the existing CLI config helper so the on-disk shape and
      // validation logic stay shared with `weflowctl config set …`.
      const { updateCliConfig } = await import(
        "../../../../tooling/weflowctl/src/cli-config.js"
      );
      try {
        await updateCliConfig({
          "update.enabled": body.data.enabled,
          "update.strategy": body.data.strategy,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(500).send({ error: "auto_update_config_failed", detail: message });
      }
      const next = await readAutoUpdateConfig(autoUpdateConfigPath());
      return {
        enabled: next.enabled,
        strategy: next.strategy,
      };
    },
  );
}

async function enrichWithLocalState(
  npmPackages: NpmPackageSummary[],
  scope: string,
): Promise<
  Array<
    NpmPackageSummary & {
      installedVersions: string[];
      activeVersion: string | null;
      updateAvailable: boolean;
      status:
        | "installed"
        | "update-available"
        | "not-installed";
    }
  >
> {
  const out: Array<
    NpmPackageSummary & {
      installedVersions: string[];
      activeVersion: string | null;
      updateAvailable: boolean;
      status: "installed" | "update-available" | "not-installed";
    }
  > = [];
  for (const item of npmPackages) {
    // npm-side package id is the npm name (e.g. @weflow-leaif/customer-support-strategy).
    // The Solution manifest's `metadata.id` is the on-platform id, which may
    // differ (`weflow.customer-support-strategy`). We try the npm name first
    // and then the implicit weflow.<basename> mapping.
    const candidates = [item.name, `${scope.replace("@", "weflow.")}/...`];
    void candidates;
    const installedVersions = await listInstalledVersions(item.name).catch(
      () => [],
    );
    const activeVersion = await readActiveVersion(item.name);
    const updateAvailable =
      Boolean(activeVersion) &&
      Boolean(item.version) &&
      activeVersion !== item.version;
    out.push({
      ...item,
      installedVersions,
      activeVersion,
      updateAvailable,
      status: !activeVersion
        ? installedVersions.length > 0
          ? "installed"
          : "not-installed"
        : updateAvailable
          ? "update-available"
          : "installed",
    });
  }
  return out;
}

function replyError(
  reply: FastifyReply,
  error: unknown,
  fallback: string,
) {
  const wrapped = error as MarketplaceError;
  const httpStatus = wrapped.httpStatus ?? 500;
  const code = wrapped.code ?? fallback;
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(httpStatus).send({ error: code, detail: message });
}

/** Create a completed operation record so the Console frontend can poll it. */
async function createMarketOperation(
  db: NodePgDatabase<typeof schema>,
  solutionId: string,
  type: string,
  state: string,
): Promise<string> {
  const operationId = `mkt-${randomUUID().slice(0, 8)}`;
  try {
    await db.insert(schema.solutionOperations).values({
      operationId,
      solutionId,
      type,
      state,
      idempotencyKey: `market-${solutionId}-${Date.now()}`,
      attempt: 1,
      actor: "marketplace",
      checkpoint: state === "succeeded" ? `${type}-completed` : null,
    });
  } catch {
    // Non-fatal: the install/update already succeeded; the operation record
    // is only for UI tracking.
  }
  return operationId;
}

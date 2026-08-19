import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  solutionPayloadDigest,
  validateSolutionLock,
  validateSolutionManifest,
  verifyDocumentSignature,
} from "@weflow/solution-sdk";
import type {
  SecretAssignmentDTO,
  SolutionRunnerClient,
  SolutionOperationDTO,
} from "./client.js";

export interface RunnerOptions {
  publicKeyPem?: string;
  allowUnsigned?: boolean;
  stagingRoot?: string;
}

export async function runOnce(
  client: SolutionRunnerClient,
  logger: Pick<Console, "error" | "info"> = console,
  options: RunnerOptions = {},
): Promise<number> {
  const operations = await client.listClaimable();
  let processed = 0;
  for (const operation of operations) {
    try {
      await processOperation(client, operation, options);
      processed += 1;
    } catch (error) {
      logger.error(
        { operationId: operation.operationId, error },
        "solution operation processing failed",
      );
      await client
        .fail(operation.operationId, "runner_internal_error")
        .catch((failError: unknown) => {
          logger.error(
            { operationId: operation.operationId, failError },
            "failed to report runner failure",
          );
        });
    }
  }
  return processed;
}

async function processOperation(
  client: SolutionRunnerClient,
  operation: SolutionOperationDTO,
  options: RunnerOptions,
): Promise<void> {
  const claimed = await client.claim(operation.operationId);
  await client.start(claimed.operationId);

  let manifestVersion: string | undefined;
  let payload;
  try {
    payload = await client.getPayload(claimed.operationId);
  } catch (error) {
    if (operation.type === "install" || operation.type === "upgrade") {
      throw error;
    }
    payload = undefined;
  }

  if (payload) {
    if (!verifyPayloadSignature(payload, options)) {
      await client.fail(claimed.operationId, "invalid_signature");
      return;
    }

    const manifestResult = validateSolutionManifest(payload.manifestJson);
    if (!manifestResult.ok) {
      await client.fail(claimed.operationId, "invalid_manifest");
      return;
    }
    const lockResult = validateSolutionLock(payload.lockJson);
    if (!lockResult.ok) {
      await client.fail(claimed.operationId, "invalid_lock");
      return;
    }

    const actualDigest = solutionPayloadDigest(
      manifestResult.value,
      lockResult.value,
    );
    if (operation.planDigest && operation.planDigest !== actualDigest) {
      await client.fail(claimed.operationId, "plan_digest_mismatch");
      return;
    }
    manifestVersion = manifestResult.value.metadata.version;

    await client.checkpoint(claimed.operationId, "validate_payload");
    await client.checkpoint(claimed.operationId, "download_artifacts");

    const artifactResult = await verifyFileArtifacts(lockResult.value, options);
    if (!artifactResult.ok) {
      await client.fail(claimed.operationId, artifactResult.errorCode);
      return;
    }
    await client.checkpoint(claimed.operationId, "verify_artifacts");

    const assignments = await client.getSecretAssignments(
      manifestResult.value.metadata.id,
    );
    const resolvedSecrets = resolveSecretAssignments(assignments);
    if (Object.keys(resolvedSecrets).length > 0) {
      console.info(
        { slots: Object.keys(resolvedSecrets) },
        "resolved secret references",
      );
    }
    await client.checkpoint(claimed.operationId, "resolve_secrets");

    await client.checkpoint(claimed.operationId, "run_migrations");
    await client.checkpoint(claimed.operationId, "deploy_apps");
    await client.checkpoint(claimed.operationId, "health_check");
  } else {
    await client.checkpoint(claimed.operationId, "no_payload_required");
  }

  await client.complete(claimed.operationId, {
    ...(manifestVersion === undefined ? {} : { solutionVersion: manifestVersion }),
    checkpoint: payload ? "health_check" : "no_payload_required",
  });
}

function verifyPayloadSignature(
  payload: {
    manifestJson: Record<string, unknown>;
    signatureJson: Record<string, unknown>;
  },
  options: RunnerOptions,
): boolean {
  if (!options.publicKeyPem) {
    return Boolean(options.allowUnsigned);
  }
  return verifyDocumentSignature(
    payload.manifestJson,
    payload.signatureJson as unknown as Parameters<typeof verifyDocumentSignature>[1],
    options.publicKeyPem,
  );
}

export function resolveArtifactPath(stagingRoot: string, ref: string): string {
  const root = resolve(stagingRoot);
  const candidate = resolve(root, ref);
  const rel = relative(root, candidate);
  if (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.split(sep).includes("..")
  ) {
    throw new Error(`artifact ref escapes staging root: ${ref}`);
  }
  return candidate;
}

export function resolveSecretAssignments(
  assignments: SecretAssignmentDTO[],
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const assignment of assignments) {
    if (assignment.refType === "env") {
      const value = process.env[assignment.refValue];
      if (value !== undefined) resolved[assignment.slotName] = value;
    } else if (assignment.refType === "file") {
      try {
        resolved[assignment.slotName] = readFileSync(
          resolve(assignment.refValue),
          "utf8",
        ).trim();
      } catch {
        // Missing file is left unresolved; Core still reports missing status.
      }
    }
  }
  return resolved;
}

export async function verifyFileArtifacts(
  lock: {
    artifacts: Array<{ id: string; ref: string; registry?: string; digest: string }>;
  },
  options: RunnerOptions,
): Promise<{ ok: true } | { ok: false; errorCode: string }> {
  if (!options.stagingRoot) {
    return { ok: false, errorCode: "missing_staging_root" };
  }

  for (const artifact of lock.artifacts) {
    const registry = artifact.registry ?? "file";
    if (registry !== "file") {
      return { ok: false, errorCode: "unsupported_registry" };
    }
    let path: string;
    try {
      path = resolveArtifactPath(options.stagingRoot, artifact.ref);
    } catch {
      return { ok: false, errorCode: "artifact_path_escape" };
    }
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      return { ok: false, errorCode: "artifact_not_found" };
    }
    const actualDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (actualDigest !== artifact.digest) {
      return { ok: false, errorCode: "artifact_digest_mismatch" };
    }
  }
  return { ok: true };
}

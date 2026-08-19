import type { RuntimeStatus } from "@weflow/contracts";
import type {
  SolutionDetail,
  SolutionOperation,
  SolutionOperationState,
  SolutionOperationType,
  SolutionSummary,
} from "./types.js";

const DESIRED_STATES = ["disabled", "active", "removed"] as const;
const OBSERVED_STATES = [
  "absent",
  "installing",
  "installed",
  "configured",
  "activating",
  "active",
  "degraded",
  "rolling_back",
  "uninstalling",
  "removed",
  "failed",
] as const;
const HEALTH_STATES = ["unknown", "healthy", "degraded", "unhealthy"] as const;
const OPERATION_TYPES = [
  "install",
  "configure",
  "activate",
  "disable",
  "upgrade",
  "rollback",
  "uninstall",
] as const;
const OPERATION_STATES = [
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
const RUNTIME_STATES = [
  "starting",
  "ready",
  "degraded",
  "stopped",
  "unknown",
] as const;
const RUNTIME_COMPONENTS = [
  "core",
  "console",
  "agent-worker",
  "ingestion-worker",
  "solution-runner",
  "weflowctl",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid admin response: ${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`invalid admin response: ${key} must be a string`);
  }
  return value;
}

function optionalNullableString(
  obj: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new Error(`invalid admin response: ${key} must be a string or null`);
  }
  return value;
}

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`invalid admin response: ${key} must be an integer`);
  }
  return value;
}

function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = obj[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid admin response: ${key} has unsupported value`);
  }
  return value as T;
}

export function parseSolutionSummary(value: unknown): SolutionSummary {
  if (!isRecord(value)) throw new Error("invalid admin response: expected object");
  return {
    solutionId: requireString(value, "solutionId"),
    version: requireString(value, "version"),
    name: requireString(value, "name"),
    publisher: requireString(value, "publisher"),
    desiredState: requireEnum(value, "desiredState", DESIRED_STATES),
    observedState: requireEnum(value, "observedState", OBSERVED_STATES),
    healthState: requireEnum(value, "healthState", HEALTH_STATES),
  };
}

export function parseSolutionOperation(value: unknown): SolutionOperation {
  if (!isRecord(value)) throw new Error("invalid admin response: expected object");
  return {
    operationId: requireString(value, "operationId"),
    solutionId: requireString(value, "solutionId"),
    type: requireEnum(value, "type", OPERATION_TYPES) as SolutionOperationType,
    state: requireEnum(value, "state", OPERATION_STATES) as SolutionOperationState,
    idempotencyKey: requireString(value, "idempotencyKey"),
    ...(optionalString(value, "planDigest") === undefined
      ? {}
      : { planDigest: optionalString(value, "planDigest") as string }),
    attempt: requireNumber(value, "attempt"),
    ...(optionalString(value, "claimedAt") === undefined
      ? {}
      : { claimedAt: optionalString(value, "claimedAt") as string }),
    ...(optionalString(value, "leaseUntil") === undefined
      ? {}
      : { leaseUntil: optionalString(value, "leaseUntil") as string }),
    ...(optionalString(value, "checkpoint") === undefined
      ? {}
      : { checkpoint: optionalString(value, "checkpoint") as string }),
    ...(optionalString(value, "errorCode") === undefined
      ? {}
      : { errorCode: optionalString(value, "errorCode") as string }),
    actor: requireString(value, "actor"),
    ...(optionalString(value, "createdAt") === undefined
      ? {}
      : { createdAt: optionalString(value, "createdAt") as string }),
  };
}

export function parseRuntimeStatus(value: unknown): RuntimeStatus {
  if (!isRecord(value)) throw new Error("invalid admin response: expected object");
  return {
    component: requireEnum(value, "component", RUNTIME_COMPONENTS),
    state: requireEnum(value, "state", RUNTIME_STATES),
    ...(optionalString(value, "version") === undefined
      ? {}
      : { version: optionalString(value, "version") as string }),
    ...(optionalString(value, "lastHeartbeatAt") === undefined
      ? {}
      : { lastHeartbeatAt: optionalString(value, "lastHeartbeatAt") as string }),
  };
}

export function parseSolutionDetail(value: unknown): SolutionDetail {
  if (!isRecord(value)) throw new Error("invalid admin response: expected object");
  const summary = parseSolutionSummary(value);
  if (!isRecord(value.compatibility)) {
    throw new Error("invalid admin response: compatibility must be an object");
  }
  const compatibility = value.compatibility;
  const pluginSdk = optionalString(compatibility, "pluginSdk");
  if (!Array.isArray(value.permissions) || !value.permissions.every((item) => typeof item === "string")) {
    throw new Error("invalid admin response: permissions must be string[]");
  }
  if (!Array.isArray(value.secretsConfigured) || !value.secretsConfigured.every((item) => typeof item === "string")) {
    throw new Error("invalid admin response: secretsConfigured must be string[]");
  }
  if (!Array.isArray(value.recentOperations)) {
    throw new Error("invalid admin response: recentOperations must be an array");
  }
  const rollbackVersion = optionalNullableString(value, "rollbackVersion");
  return {
    ...summary,
    compatibility: {
      platform: requireString(compatibility, "platform"),
      ...(pluginSdk === undefined ? {} : { pluginSdk }),
    },
    permissions: value.permissions as string[],
    secretsConfigured: value.secretsConfigured as string[],
    recentOperations: value.recentOperations.map(parseSolutionOperation),
    ...(rollbackVersion === undefined ? {} : { rollbackVersion }),
  };
}

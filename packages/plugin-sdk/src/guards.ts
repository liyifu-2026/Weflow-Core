import type {
  CapabilityToken,
  PluginRestartPolicy,
  PluginRuntimeType,
  RuntimePluginManifest,
} from "./types.js";

const RUNTIME_TYPES: readonly PluginRuntimeType[] = [
  "node",
  "isolated",
  "container",
];

const RESTART_POLICIES: readonly PluginRestartPolicy[] = [
  "always",
  "on-failure",
  "never",
];

export function isCapabilityToken(value: unknown): value is CapabilityToken {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && record.name.length > 0;
}

export function isPluginManifest(value: unknown): value is RuntimePluginManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.apiVersion !== "weflow.io/v1" || record.kind !== "Plugin") {
    return false;
  }
  if (typeof record.metadata !== "object" || record.metadata === null) {
    return false;
  }
  const metadata = record.metadata as Record<string, unknown>;
  if (
    typeof metadata.id !== "string" ||
    metadata.id.length === 0 ||
    typeof metadata.name !== "string" ||
    metadata.name.length === 0 ||
    typeof metadata.version !== "string" ||
    metadata.version.length === 0
  ) {
    return false;
  }
  if (typeof record.runtime !== "object" || record.runtime === null) {
    return false;
  }
  const runtime = record.runtime as Record<string, unknown>;
  if (typeof runtime.entry !== "string" || runtime.entry.length === 0) {
    return false;
  }
  if (
    typeof runtime.type !== "string" ||
    !(RUNTIME_TYPES as readonly string[]).includes(runtime.type)
  ) {
    return false;
  }
  if (
    runtime.restartPolicy !== undefined &&
    (typeof runtime.restartPolicy !== "string" ||
      !(RESTART_POLICIES as readonly string[]).includes(runtime.restartPolicy))
  ) {
    return false;
  }
  if (!Array.isArray(record.capabilities)) return false;
  return record.capabilities.every(isCapabilityToken);
}

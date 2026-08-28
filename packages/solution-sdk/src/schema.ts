/**
 * Pure (browser-safe) Solution package schemas and validators.
 *
 * This module must never import Node built-ins: the browser entry and the
 * Node entry both build on it. Cryptographic digest/signature helpers live in
 * `index.ts` (Node) and `browser.ts` (Web Crypto).
 */
import { z } from "zod";

const idSchema = z.string().regex(/^[a-z][a-z0-9._/-]{0,127}$/);
const versionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const permissionNewSchema = z
  .object({
    id: z.string().min(1).max(100),
    reason: z.string().trim().min(1).max(500),
    risk: z.enum(["low", "medium", "high"]),
  })
  .strict();

const permissionLegacySchema = z
  .object({
    id: z.string().min(1).max(100),
    resource: z.string().trim().min(1).max(160),
    action: z.enum(["read", "write", "execute", "admin"]),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

const permissionSchema = z.union([permissionNewSchema, permissionLegacySchema]);

const artifactNewSchema = z
  .object({
    id: idSchema,
    kind: z.enum(["plugin", "application", "asset"]),
    ref: z.string().trim().min(1).max(2_048),
    digest: digestSchema.optional(),
    version: versionSchema.optional(),
    targetProcess: z
      .enum(["core", "agent-worker", "ingestion-worker", "external"])
      .optional(),
  })
  .strict();

const LEGACY_ARTIFACT_KIND = {
  plugin: "plugin",
  app: "application",
  container: "asset",
  resource: "asset",
} as const;

const artifactLegacySchema = z
  .object({
    id: idSchema,
    type: z.enum(["plugin", "app", "container", "resource"]),
    ref: z.string().trim().min(1).max(2_048),
    digest: z.string().trim().max(2_048).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strict()
  .transform((item) => ({
    id: item.id,
    kind: LEGACY_ARTIFACT_KIND[item.type],
    ref: item.ref,
    ...(item.digest ? { digest: item.digest } : {}),
    ...(item.size !== undefined ? { size: item.size } : {}),
  }));

const artifactSchema = z.union([artifactNewSchema, artifactLegacySchema]);

const applicationNewSchema = z
  .object({
    id: idSchema,
    kind: z.enum(["web", "mobile", "bff", "worker"]),
    artifactId: idSchema,
    healthPath: z.string().startsWith("/").max(200).optional(),
    basePath: z.string().startsWith("/").max(200).optional(),
  })
  .strict();

const applicationLegacySchema = z
  .object({
    id: idSchema,
    type: z.enum(["web", "mobile", "bff", "worker"]),
    entry: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .transform((item) => ({
    id: item.id,
    kind: item.type,
    entry: item.entry,
  }));

const applicationRefSchema = z
  .object({
    id: idSchema,
    kind: z.enum(["web", "mobile", "bff", "worker"]),
    entry: z.string().trim().min(1).max(2_000),
  })
  .strict();

const applicationSchema = z.union([
  applicationNewSchema,
  applicationRefSchema,
  applicationLegacySchema,
]);

const resourceNewSchema = z
  .object({
    id: idSchema,
    kind: z.enum([
      "agent_definition",
      "policy",
      "evaluation",
      "knowledge_template",
      "asset",
    ]),
    spec: z.record(z.string(), z.unknown()),
  })
  .strict();

const LEGACY_RESOURCE_KIND = {
  "agent-definition": "agent_definition",
  policy: "policy",
  evaluation: "evaluation",
  "knowledge-template": "knowledge_template",
  schema: "asset",
  ledger: "asset",
  role: "asset",
} as const;

const resourceLegacySchema = z
  .object({
    id: idSchema,
    type: z.enum([
      "schema",
      "ledger",
      "role",
      "agent-definition",
      "policy",
      "evaluation",
      "knowledge-template",
    ]),
    ref: z.string().trim().min(1).max(2_048),
  })
  .strict()
  .transform((item) => ({
    id: item.id,
    kind: LEGACY_RESOURCE_KIND[item.type],
    ref: item.ref,
  }));

const resourceRefSchema = z
  .object({
    id: idSchema,
    kind: z.enum([
      "agent_definition",
      "policy",
      "evaluation",
      "knowledge_template",
      "asset",
    ]),
    ref: z.string().trim().min(1).max(2_048),
  })
  .strict();

const resourceSchema = z.union([
  resourceNewSchema,
  resourceRefSchema,
  resourceLegacySchema,
]);

const executionProfileSkillRefSchema = z
  .object({
    id: idSchema,
    version: versionSchema.optional(),
  })
  .strict();

const executionProfileSchema = z
  .object({
    id: idSchema,
    strategyRef: z.string().trim().min(1).max(200),
    maxModelCalls: z.number().int().min(1).max(8),
    maxToolCalls: z.number().int().min(0).max(8),
    timeoutSeconds: z.number().int().min(1).max(300),
    allowedTools: z.array(z.string().trim().min(1).max(100)).max(32),
    skills: z
      .array(
        z.union([
          z.string().trim().min(1).max(200),
          executionProfileSkillRefSchema,
        ]),
      )
      .max(32),
  })
  .strict();

const secretSlotNewSchema = z
  .object({
    id: idSchema,
    description: z.string().trim().max(500).optional(),
    required: z.boolean(),
    source: z.enum(["env", "file"]),
  })
  .strict();

const secretSlotLegacySchema = z
  .object({
    name: idSchema,
    kind: z.enum(["env", "file"]),
    required: z.boolean(),
    description: z.string().trim().max(500).optional(),
  })
  .strict()
  .transform((item) => ({
    id: item.name,
    description: item.description,
    required: item.required,
    source: item.kind,
    ...(item.description ? { description: item.description } : {}),
  }));

const secretSlotSchema = z.union([secretSlotNewSchema, secretSlotLegacySchema]);

const healthCheckNewSchema = z
  .object({
    id: idSchema,
    target: z.string().trim().min(1).max(200),
    url: z.string().startsWith("/").max(300),
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
  })
  .strict();

const healthCheckLegacySchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(200).optional(),
    type: z.enum(["http", "tcp", "process"]),
    target: z.string().trim().min(1).max(200),
    port: z.number().int().min(1).max(65_535).optional(),
    timeoutSeconds: z.number().int().min(1).max(300).optional(),
  })
  .strict()
  .transform((item) => ({
    id: item.id,
    ...(item.name ? { name: item.name } : {}),
    type: item.type,
    target: item.target,
    ...(item.port !== undefined ? { port: item.port } : {}),
    ...(item.timeoutSeconds !== undefined
      ? { timeoutSeconds: item.timeoutSeconds }
      : {}),
  }));

const healthCheckSchema = z.union([
  healthCheckNewSchema,
  healthCheckLegacySchema,
]);

/** 平台总览卡片契约（metric 由平台计算，href 指向 Console 内相对路径） */
export const dashboardContributionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(80),
    metric: z
      .enum(["today_conversations", "pending_handoffs", "active_solutions"])
      .optional(),
    href: z.string().trim().min(1).max(300).optional(),
    unit: z.string().trim().min(1).max(16).optional(),
  })
  .strict();

const consoleExtensionSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1).max(160),
    path: z.string().trim().regex(/^\//, "must start with /").max(200),
    entry: z.string().trim().min(1).max(2_000),
    icon: z.string().trim().min(1).max(100).optional(),
    group: z.string().trim().min(1).max(100).optional(),
    adminOnly: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

export const solutionManifestSchema = z
  .object({
    apiVersion: z.literal("weflow.io/v1"),
    kind: z.literal("Solution"),
    metadata: z
      .object({
        id: idSchema,
        name: z.string().trim().min(1).max(160),
        version: versionSchema,
        publisher: z.string().trim().min(1).max(160),
        description: z.string().trim().max(2_000).optional(),
      })
      .strict(),
    compatibility: z
      .object({
        platform: z.string().trim().min(1).max(100),
        pluginSdk: z.string().trim().min(1).max(100),
      })
      .strict(),
    dependencies: z
      .object({
        capabilities: z.array(z.string().trim().min(1).max(160)).max(64),
        solutions: z.array(idSchema).max(32),
      })
      .strict(),
    artifacts: z.array(artifactSchema).max(128),
    permissions: z.array(permissionSchema).max(128),
    configuration: z
      .object({
        schemaRef: z.string().trim().max(500).optional(),
        defaults: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
    secretSlots: z.array(secretSlotSchema).max(64),
    resources: z.array(resourceSchema).max(256),
    executionProfiles: z.array(executionProfileSchema).max(32),
    applications: z.array(applicationSchema).max(64),
    healthChecks: z.array(healthCheckSchema).max(64),
    consoleExtensions: z.array(consoleExtensionSchema).max(64).default([]),
    // 平台总览卡片（dashboardContributions）：业务方案向平台总览声明的小卡片。
    // metric 由平台按 key 计算；href 为 Console 内相对路径（业务页面由 ExtensionHost 承载）。
    dashboardContributions: z
      .array(dashboardContributionSchema)
      .max(16)
      .default([]),
  })
  .strict();

export const solutionLockSchema = z
  .object({
    apiVersion: z.literal("weflow.io/v1"),
    solutionId: idSchema,
    solutionVersion: versionSchema,
    manifestDigest: digestSchema,
    resolvedArtifacts: z
      .array(
        z
          .object({
            id: idSchema,
            ref: z.string().trim().min(1).max(2_048),
            digest: digestSchema,
            size: z.number().int().nonnegative(),
            sbomRef: z.string().trim().max(2_048).optional(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

export const solutionSignatureSchema = z
  .object({
    algorithm: z.literal("ed25519"),
    keyId: z.string().trim().min(1).max(200),
    signature: z.string().regex(/^[A-Za-z0-9+/=]+$/),
  })
  .strict();

export type SolutionManifestV1 = z.infer<typeof solutionManifestSchema>;
export type SolutionLockV1 = z.infer<typeof solutionLockSchema>;
export type SolutionSignature = z.infer<typeof solutionSignatureSchema>;
export type SolutionDescriptor = {
  manifest: SolutionManifestV1;
  lock?: SolutionLockV1;
  manifestDigest: string;
  lockDigest?: string;
};

export type SolutionPackageFiles = {
  manifest: unknown;
  lock: unknown;
  signature: unknown;
};

export type SolutionPackageDescriptor = SolutionDescriptor & {
  lock: SolutionLockV1;
  signature: SolutionSignature;
};

// Backward-compatible public aliases for consumers of the older SDK dist.
export type SolutionMetadata = z.infer<
  typeof solutionManifestSchema.shape.metadata
>;
export type SolutionCompatibility = z.infer<
  typeof solutionManifestSchema.shape.compatibility
>;
export type SolutionDependencies = z.infer<
  typeof solutionManifestSchema.shape.dependencies
>;
export type SolutionArtifact = z.infer<typeof artifactSchema>;
export type SolutionPermission = z.infer<typeof permissionSchema>;
export type SolutionSecretSlot = z.infer<typeof secretSlotSchema>;
export type SolutionResource = z.infer<typeof resourceSchema>;
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
export type SolutionApplication = z.infer<typeof applicationSchema>;
export type HealthCheck = z.infer<typeof healthCheckSchema>;
export type SolutionConsoleExtension = z.infer<typeof consoleExtensionSchema>;

export function parseSolutionManifest(input: unknown): SolutionManifestV1 {
  return solutionManifestSchema.parse(input);
}

export function parseSolutionLock(input: unknown): SolutionLockV1 {
  return solutionLockSchema.parse(input);
}

export function normalizeSolutionManifest(
  input: SolutionManifestV1,
): SolutionManifestV1 {
  return {
    ...input,
    dependencies: {
      capabilities: [...input.dependencies.capabilities].sort(),
      solutions: [...input.dependencies.solutions].sort(),
    },
    artifacts: [...input.artifacts].sort((a, b) => a.id.localeCompare(b.id)),
    permissions: [...input.permissions].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    secretSlots: [...input.secretSlots].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    resources: [...input.resources].sort((a, b) => a.id.localeCompare(b.id)),
    executionProfiles: [...input.executionProfiles].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    applications: [...input.applications].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    healthChecks: [...input.healthChecks].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    consoleExtensions: [...input.consoleExtensions].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
  };
}

export type SolutionManifestValidationResult =
  | { ok: true; value: SolutionManifestV1 }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/** Compatibility validator matching the public SDK API used by Solutions. */
export function validateSolutionManifest(
  input: unknown,
): SolutionManifestValidationResult {
  try {
    return {
      ok: true,
      value: normalizeSolutionManifest(parseSolutionManifest(input)),
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        issues: error.issues.map((issue) => ({
          path: issue.path.length > 0 ? issue.path.join(".") : "$",
          message: issue.message,
        })),
      };
    }
    throw error;
  }
}

export type SolutionLockValidationResult =
  | { ok: true; value: SolutionLockV1 }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/** Non-throwing lock validation for browser/UI consumers. */
export function validateSolutionLock(
  input: unknown,
): SolutionLockValidationResult {
  try {
    return { ok: true, value: parseSolutionLock(input) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        issues: error.issues.map((issue) => ({
          path: issue.path.length > 0 ? issue.path.join(".") : "$",
          message: issue.message,
        })),
      };
    }
    throw error;
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

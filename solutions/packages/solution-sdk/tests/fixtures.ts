import { manifestDigest } from "../src/canonical.js";
import type {
  PlannerInput,
  SolutionLockV1,
  SolutionManifestV1,
} from "../src/types.js";

export const sampleManifest: SolutionManifestV1 = {
  apiVersion: "weflow.io/v1",
  kind: "Solution",
  metadata: {
    id: "weflow.customer-support",
    name: "Customer Support Solution",
    version: "1.0.0",
    publisher: "weflow",
  },
  compatibility: {
    platform: ">=1.0.0 <2.0.0",
    pluginSdk: "^1.0.0",
  },
  dependencies: {
    capabilities: ["knowledge.retrieval"],
    solutions: [],
  },
  artifacts: [
    {
      id: "support-strategy",
      type: "plugin",
      ref: "npm:@weflow/customer-support-strategy",
      digest: `sha256:${"a".repeat(64)}`,
    },
  ],
  permissions: [
    {
      id: "read-conversations",
      resource: "conversations",
      action: "read",
    },
  ],
  configuration: {},
  secretSlots: [
    {
      name: "support_bff_api_key",
      kind: "env",
      required: true,
    },
  ],
  resources: [
    {
      id: "support-schema",
      type: "schema",
      ref: "support",
    },
  ],
  executionProfiles: [
    {
      id: "profile-v1",
      strategyRef: "weflow.customer-support/structured-v1",
      maxModelCalls: 2,
      maxToolCalls: 1,
      timeoutSeconds: 60,
      allowedTools: ["query_contact_profile"],
      skills: [
        {
          id: "weflow.customer-support/product-troubleshooting",
          version: "1.0.0",
        },
      ],
    },
  ],
  applications: [
    {
      id: "support-web",
      type: "web",
      entry: "/support",
    },
  ],
  healthChecks: [
    {
      id: "support-web-health",
      type: "http",
      target: "/healthz",
      timeoutSeconds: 5,
    },
  ],
};

export const sampleLock: SolutionLockV1 = {
  apiVersion: "weflow.io/v1",
  kind: "SolutionLock",
  solutionId: "weflow.customer-support",
  solutionVersion: "1.0.0",
  manifestDigest: manifestDigest(sampleManifest),
  dependencies: [],
  artifacts: [
    {
      id: "support-strategy",
      ref: "npm:@weflow/customer-support-strategy",
      registry: "npm",
      digest: `sha256:${"a".repeat(64)}`,
      size: 1024,
      platform: "linux",
      architecture: "x64",
    },
    {
      id: "support-schema",
      ref: "support-schema.sql",
      registry: "file",
      digest: `sha256:${"b".repeat(64)}`,
    },
  ],
  targetPlatform: "linux",
  targetArchitecture: "x64",
  sbom: "sbom.json",
};

export function samplePlannerInput(
  overrides: Partial<PlannerInput> = {},
): PlannerInput {
  return {
    descriptor: {
      manifest: sampleManifest,
      lock: sampleLock,
    },
    platformVersion: "1.2.0",
    pluginSdkVersion: "1.0.0",
    installedSolutions: [],
    capabilityCatalog: [
      {
        id: "knowledge.retrieval",
        providedBy: "weflow-provider-weknora",
        version: "1.0.0",
      },
    ],
    artifactCatalog: [
      {
        id: "support-strategy",
        ref: "npm:@weflow/customer-support-strategy",
        registry: "npm",
        digest: `sha256:${"a".repeat(64)}`,
      },
      {
        id: "support-schema",
        ref: "support-schema.sql",
        registry: "file",
        digest: `sha256:${"b".repeat(64)}`,
      },
    ],
    secretInventory: {
      configured: ["support_bff_api_key"],
    },
    runtimeState: {
      processes: ["core"],
      available: true,
    },
    ...overrides,
  };
}

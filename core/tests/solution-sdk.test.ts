import { describe, expect, it } from "vitest";
import {
  describeSolution,
  parseSolutionManifest,
  sha256Digest,
  validateSolutionManifest,
  type SolutionManifestV1,
} from "@weflow/solution-sdk";

const manifest = {
  apiVersion: "weflow.io/v1",
  kind: "Solution",
  metadata: {
    id: "weflow.example-solution",
    name: "Example Solution",
    version: "1.0.0",
    publisher: "weflow",
  },
  compatibility: { platform: ">=1.0.0 <2.0.0", pluginSdk: "^1.0.0" },
  dependencies: { capabilities: [], solutions: [] },
  artifacts: [],
  permissions: [],
  configuration: { defaults: {} },
  secretSlots: [],
  resources: [],
  executionProfiles: [],
  applications: [],
  healthChecks: [],
} as const;

describe("Solution Package Contract", () => {
  it("strictly validates and produces a stable manifest digest", () => {
    const parsed = parseSolutionManifest(manifest);
    const descriptor = describeSolution(manifest);
    expect(parsed.metadata.id).toBe("weflow.example-solution");
    expect(descriptor.manifestDigest).toBe(sha256Digest(descriptor.manifest));
  });

  it("rejects unknown manifest fields", () => {
    expect(() =>
      parseSolutionManifest({ ...manifest, unknown: true }),
    ).toThrow();
  });

  it("defaults consoleExtensions to an empty array for legacy manifests", () => {
    const parsed = parseSolutionManifest(manifest);
    expect(parsed.consoleExtensions).toEqual([]);
  });

  it("accepts and normalizes declared console extensions", () => {
    const withExtensions = {
      ...manifest,
      consoleExtensions: [
        {
          id: "support-conversations",
          title: "客服工作台",
          path: "/support/conversations",
          entry: "apps/support-web/dist/support-web.js",
          group: "客服业务",
        },
        {
          id: "support-coach",
          title: "质量评测",
          path: "/support/coach",
          entry: "apps/support-web/dist/support-web.js",
          group: "客服业务",
          adminOnly: true,
        },
      ],
    };
    const parsed = parseSolutionManifest(withExtensions);
    expect(parsed.consoleExtensions).toHaveLength(2);
    const normalized = validateSolutionManifest(withExtensions);
    assertOk(normalized);
    expect(normalized.value.consoleExtensions.map((item) => item.id)).toEqual([
      "support-coach",
      "support-conversations",
    ]);
  });

  it("rejects invalid console extension declarations", () => {
    const badPath = {
      ...manifest,
      consoleExtensions: [
        {
          id: "bad-path",
          title: "Bad Path",
          path: "support/no-slash",
          entry: "apps/support-web/dist/support-web.js",
        },
      ],
    };
    expect(validateSolutionManifest(badPath).ok).toBe(false);
    const unknownField = {
      ...manifest,
      consoleExtensions: [
        {
          id: "unknown-field",
          title: "Unknown Field",
          path: "/support/ok",
          entry: "apps/support-web/dist/support-web.js",
          sandbox: true,
        },
      ],
    };
    expect(validateSolutionManifest(unknownField).ok).toBe(false);
  });

  it("produces a different digest when console extensions change", () => {
    const without = describeSolution(manifest);
    const withOne = describeSolution({
      ...manifest,
      consoleExtensions: [
        {
          id: "support-overview",
          title: "运营总览",
          path: "/support/overview",
          entry: "apps/support-web/dist/support-web.js",
        },
      ],
    });
    expect(without.manifestDigest).not.toBe(withOne.manifestDigest);
  });
});

function assertOk(
  result:
    | { ok: true; value: unknown }
    | { ok: false; issues: Array<{ path: string; message: string }> },
): asserts result is {
  ok: true;
  value: SolutionManifestV1;
} {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
}

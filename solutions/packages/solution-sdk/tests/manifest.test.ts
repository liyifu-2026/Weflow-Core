import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSolutionManifest } from "../src/manifest.js";
import { sampleManifest } from "./fixtures.js";

describe("validateSolutionManifest", () => {
  it("accepts a valid manifest", () => {
    const result = validateSolutionManifest(sampleManifest);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.metadata.id, "weflow.customer-support");
    }
  });

  it("rejects unknown top-level fields", () => {
    const result = validateSolutionManifest({
      ...sampleManifest,
      installer: "curl ...",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.issues.some((issue) => issue.path === "$.installer"),
        true,
      );
    }
  });

  it("rejects unknown artifact types", () => {
    const result = validateSolutionManifest({
      ...sampleManifest,
      artifacts: [
        {
          id: "bad-artifact",
          type: "shell-script",
          ref: "scripts/install.sh",
        },
      ],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.issues.some((issue) =>
          issue.path.startsWith("$.artifacts[0].type"),
        ),
        true,
      );
    }
  });

  it("rejects duplicate artifact ids", () => {
    const result = validateSolutionManifest({
      ...sampleManifest,
      artifacts: [
        {
          id: "support-strategy",
          type: "plugin",
          ref: "npm:@weflow/customer-support-strategy",
        },
        {
          id: "support-strategy",
          type: "app",
          ref: "npm:@weflow/customer-support-web",
        },
      ],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.issues.some((issue) => issue.message.includes("duplicate id")),
        true,
      );
    }
  });

  it("rejects invalid semantic versions", () => {
    const result = validateSolutionManifest({
      ...sampleManifest,
      metadata: {
        ...sampleManifest.metadata,
        version: "latest",
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.issues.some((issue) => issue.path === "$.metadata.version"),
        true,
      );
    }
  });
});

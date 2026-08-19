import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPluginHarness } from "../src/testkit.js";
import { isPluginManifest } from "../src/guards.js";
import type { RuntimePluginManifest } from "../src/types.js";

const manifest: RuntimePluginManifest = {
  apiVersion: "weflow.io/v1",
  kind: "Plugin",
  metadata: {
    id: "weflow.customer-support-strategy",
    name: "Customer Support Strategy",
    version: "1.0.0",
    publisher: "weflow",
  },
  runtime: {
    entry: "dist/index.js",
    type: "node",
  },
  capabilities: [
    {
      name: "agent.execution-strategy",
      version: "1.0.0",
    },
  ],
  tools: [
    {
      id: "query_contact_profile",
      handler: async () => ({ ok: true }),
    },
  ],
  skills: [
    {
      id: "weflow.customer-support/product-troubleshooting",
      version: "1.0.0",
    },
  ],
  executionStrategies: [
    {
      id: "structured-v1",
      version: "1.0.0",
      strategy: {
        id: "structured-v1",
        version: "1.0.0",
        buildModelRequest: () => ({ system: "", messages: [] }),
        parseModelResponse: () => ({ kind: "no_action", reasonCode: "test" }),
        validateAction: () => ({ ok: true }),
      },
    },
  ],
};

describe("plugin-sdk", () => {
  it("accepts a valid plugin manifest", () => {
    assert.equal(isPluginManifest(manifest), true);
  });

  it("rejects a manifest with wrong kind", () => {
    assert.equal(
      isPluginManifest({ ...manifest, kind: "Solution" }),
      false,
    );
  });

  it("harness indexes tools, skills and strategies", () => {
    const harness = createPluginHarness({ manifest });
    assert.equal(harness.tools.has("query_contact_profile"), true);
    assert.equal(
      harness.skills.has("weflow.customer-support/product-troubleshooting"),
      true,
    );
    assert.equal(harness.strategies.has("structured-v1"), true);
  });
});

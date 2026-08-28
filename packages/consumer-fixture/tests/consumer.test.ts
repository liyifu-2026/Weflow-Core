import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAgentAction } from "@weflow-leaif/contracts";
import {
  createPluginHarness,
  isPluginManifest,
} from "@weflow-leaif/plugin-sdk";
import type { RuntimePluginManifest } from "@weflow-leaif/plugin-sdk";
import { parseSolutionSummary } from "@weflow/admin-sdk";

describe("external consumer fixture", () => {
  it("consumes contracts through the public entry", () => {
    assert.equal(
      isAgentAction({ kind: "no_action", reasonCode: "waiting_for_user" }),
      true,
    );
  });

  it("consumes plugin-sdk through the public entry", () => {
    const manifest: RuntimePluginManifest = {
      apiVersion: "weflow.io/v1",
      kind: "Plugin",
      metadata: {
        id: "fixture.plugin",
        name: "Fixture Plugin",
        version: "0.1.0",
      },
      runtime: {
        entry: "dist/index.js",
        type: "node",
      },
      capabilities: [],
    };
    assert.equal(isPluginManifest(manifest), true);
    const harness = createPluginHarness({ manifest });
    assert.equal(harness.tools.size, 0);
  });

  it("consumes admin-sdk through the public entry", () => {
    const summary = parseSolutionSummary({
      solutionId: "example.platform",
      version: "1.0.0",
      name: "Customer Support Solution",
      publisher: "weflow",
      desiredState: "disabled",
      observedState: "installed",
      healthState: "unknown",
    });
    assert.equal(summary.solutionId, "example.platform");
  });
});

import { describe, expect, it } from "vitest";
import {
  RuntimeKernel,
  capability,
} from "../infrastructure/runtime/kernel/index.js";
import { adaptSolutionPlugin } from "../infrastructure/solutions/solution-plugin-adapter.js";
import type { LoadedSolutionPlugin } from "../infrastructure/solutions/solution-plugin-loader.js";

const SKILL_CAPABILITY = capability<{ name: string }>(
  "skill.product-troubleshooting",
);

describe("solution plugin adapter", () => {
  it("registers a structural solution plugin into the Core runtime kernel", async () => {
    const loaded: LoadedSolutionPlugin = {
      artifactId: "product-troubleshooting-skill",
      id: "weflow.customer-support-product-troubleshooting",
      plugin: {
        manifest: {
          id: "weflow.customer-support-product-troubleshooting",
          version: "1.0.0",
          sdkVersion: "1.0.0",
          provides: ["skill.product-troubleshooting"],
          requires: [],
          permissions: ["agent.context.classify"],
        },
        setup(context) {
          context.provide("skill.product-troubleshooting", {
            name: "solution-skill",
          });
        },
      },
    };

    const kernel = new RuntimeKernel();
    kernel.register(adaptSolutionPlugin(loaded));
    await kernel.start();
    expect(kernel.get(SKILL_CAPABILITY)).toEqual({ name: "solution-skill" });
    await kernel.stop();
  });
});

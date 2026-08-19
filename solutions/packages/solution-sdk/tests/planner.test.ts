import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planSolution } from "../src/planner.js";
import { samplePlannerInput } from "./fixtures.js";

describe("planSolution", () => {
  it("produces a stable planDigest for identical input", () => {
    const a = planSolution(samplePlannerInput());
    const b = planSolution(samplePlannerInput());
    assert.equal(a.planDigest, b.planDigest);
    assert.deepEqual(a.blockers, []);
  });

  it("changes planDigest when platform version changes", () => {
    const base = planSolution(samplePlannerInput());
    const incompatible = planSolution(
      samplePlannerInput({ platformVersion: "2.0.0" }),
    );
    assert.notEqual(base.planDigest, incompatible.planDigest);
    assert.equal(
      incompatible.blockers.some(
        (blocker) => blocker.code === "incompatible_platform",
      ),
      true,
    );
  });

  it("blocks when a required capability is missing", () => {
    const plan = planSolution(samplePlannerInput({ capabilityCatalog: [] }));
    assert.equal(
      plan.blockers.some((blocker) => blocker.code === "missing_capability"),
      true,
    );
  });

  it("reports missing required secrets without blocking install", () => {
    const plan = planSolution(
      samplePlannerInput({
        secretInventory: { configured: [] },
      }),
    );
    assert.equal(plan.missingSecrets.includes("support_bff_api_key"), true);
    assert.equal(
      plan.blockers.some((blocker) => blocker.code === "missing_capability"),
      false,
    );
  });

  it("blocks when a locked artifact is missing", () => {
    const input = samplePlannerInput();
    const plan = planSolution({
      ...input,
      descriptor: {
        manifest: input.descriptor.manifest,
        lock: {
          ...input.descriptor.lock,
          artifacts: [],
        },
      },
    });
    assert.equal(
      plan.blockers.some((blocker) => blocker.code === "missing_locked_artifact"),
      true,
    );
  });

  it("offers the previous version as rollback target", () => {
    const plan = planSolution(
      samplePlannerInput({
        installedSolutions: [
          {
            id: "weflow.customer-support",
            version: "0.9.0",
            desiredState: "active",
            observedState: "active",
            healthState: "healthy",
          },
        ],
      }),
    );
    assert.equal(plan.rollbackVersion, "0.9.0");
  });
});

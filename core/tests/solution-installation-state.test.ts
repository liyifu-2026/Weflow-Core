import { describe, expect, it } from "vitest";
import {
  canTransitionOperationState,
  intermediateObservedState,
  planOperationTarget,
} from "../modules/solution/application/solution-installation-state.js";

describe("Solution Installation state machine", () => {
  it("allows install from absent and targets disabled/installed", () => {
    const decision = planOperationTarget("install", {
      desiredState: "disabled",
      observedState: "absent",
      healthState: "unknown",
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.target).toMatchObject({
        desiredState: "disabled",
        observedState: "installed",
      });
    }
  });

  it("allows install completion from installing", () => {
    const decision = planOperationTarget("install", {
      desiredState: "disabled",
      observedState: "installing",
      healthState: "unknown",
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.target.observedState).toBe("installed");
    }
  });

  it("rejects install from active", () => {
    const decision = planOperationTarget("install", {
      desiredState: "active",
      observedState: "active",
      healthState: "healthy",
    });
    expect(decision.allowed).toBe(false);
  });

  it("allows activate from configured and targets active", () => {
    const decision = planOperationTarget("activate", {
      desiredState: "disabled",
      observedState: "configured",
      healthState: "unknown",
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.target).toMatchObject({
        desiredState: "active",
        observedState: "active",
      });
    }
  });

  it("allows disable from active and targets disabled/configured", () => {
    const decision = planOperationTarget("disable", {
      desiredState: "active",
      observedState: "active",
      healthState: "healthy",
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.target).toMatchObject({
        desiredState: "disabled",
        observedState: "configured",
      });
    }
  });

  it("allows uninstall from active and targets removed", () => {
    const decision = planOperationTarget("uninstall", {
      desiredState: "active",
      observedState: "active",
      healthState: "healthy",
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.target).toMatchObject({
        desiredState: "removed",
        observedState: "removed",
      });
    }
  });

  it("provides intermediate observed states for async operations", () => {
    expect(intermediateObservedState("install")).toBe("installing");
    expect(intermediateObservedState("activate")).toBe("activating");
    expect(intermediateObservedState("uninstall")).toBe("uninstalling");
    expect(intermediateObservedState("rollback")).toBe("rolling_back");
    expect(intermediateObservedState("configure")).toBeUndefined();
  });

  it("enforces operation state transitions", () => {
    expect(canTransitionOperationState("queued", "claimed")).toBe(true);
    expect(canTransitionOperationState("queued", "cancelled")).toBe(true);
    expect(canTransitionOperationState("claimed", "running")).toBe(true);
    expect(canTransitionOperationState("running", "succeeded")).toBe(true);
    expect(canTransitionOperationState("running", "failed")).toBe(true);
    expect(canTransitionOperationState("succeeded", "running")).toBe(false);
    expect(canTransitionOperationState("queued", "succeeded")).toBe(false);
  });
});

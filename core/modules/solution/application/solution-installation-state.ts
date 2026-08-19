/**
 * Solution Installation state machine.
 *
 * This module is pure: it contains no database access. It decides whether an
 * Operation may transition and what Installation target it implies.
 */

export type DesiredSolutionState = "disabled" | "active" | "removed";

export type ObservedSolutionState =
  | "absent"
  | "installing"
  | "installed"
  | "configured"
  | "activating"
  | "active"
  | "degraded"
  | "rolling_back"
  | "uninstalling"
  | "removed"
  | "failed";

export type SolutionHealthState =
  "unknown" | "healthy" | "degraded" | "unhealthy";

export type SolutionOperationType =
  | "install"
  | "configure"
  | "activate"
  | "disable"
  | "upgrade"
  | "rollback"
  | "uninstall";

export type SolutionOperationState =
  "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";

export interface SolutionInstallationState {
  desiredState: DesiredSolutionState;
  observedState: ObservedSolutionState;
  healthState: SolutionHealthState;
}

export interface OperationTarget {
  desiredState?: DesiredSolutionState;
  observedState?: ObservedSolutionState;
  healthState?: SolutionHealthState;
}

export type TransitionDecision =
  | { allowed: true; target: OperationTarget }
  | { allowed: false; reason: string };

const INSTALLABLE_OBSERVED = new Set<ObservedSolutionState>([
  "absent",
  "removed",
  "failed",
  "installing",
]);

const CONFIGURABLE_OBSERVED = new Set<ObservedSolutionState>([
  "installed",
  "degraded",
  "failed",
]);

const ACTIVATABLE_OBSERVED = new Set<ObservedSolutionState>([
  "installed",
  "configured",
  "degraded",
  "activating",
]);

const DISABLEABLE_OBSERVED = new Set<ObservedSolutionState>([
  "active",
  "degraded",
]);

const UPGRADEABLE_OBSERVED = new Set<ObservedSolutionState>([
  "installing",
  "installed",
  "configured",
  "active",
  "degraded",
]);

const ROLLBACKABLE_OBSERVED = new Set<ObservedSolutionState>([
  "installed",
  "configured",
  "active",
  "degraded",
  "failed",
  "rolling_back",
]);

const UNINSTALLABLE_OBSERVED = new Set<ObservedSolutionState>([
  "installed",
  "configured",
  "activating",
  "active",
  "degraded",
  "rolling_back",
  "uninstalling",
  "failed",
]);

export function intermediateObservedState(
  type: SolutionOperationType,
): ObservedSolutionState | undefined {
  switch (type) {
    case "install":
    case "upgrade":
      return "installing";
    case "activate":
      return "activating";
    case "rollback":
      return "rolling_back";
    case "uninstall":
      return "uninstalling";
    case "configure":
    case "disable":
      return undefined;
  }
}

export function planOperationTarget(
  type: SolutionOperationType,
  current: SolutionInstallationState,
): TransitionDecision {
  switch (type) {
    case "install":
      if (!INSTALLABLE_OBSERVED.has(current.observedState)) {
        return {
          allowed: false,
          reason: `install not allowed from observed state ${current.observedState}`,
        };
      }
      return {
        allowed: true,
        target: {
          desiredState:
            current.desiredState === "removed"
              ? "disabled"
              : current.desiredState,
          observedState: "installed",
          healthState: "unknown",
        },
      };
    case "configure":
      if (!CONFIGURABLE_OBSERVED.has(current.observedState)) {
        return {
          allowed: false,
          reason: `configure not allowed from observed state ${current.observedState}`,
        };
      }
      return {
        allowed: true,
        target: {
          desiredState:
            current.desiredState === "active"
              ? "disabled"
              : current.desiredState,
          observedState: "configured",
        },
      };
    case "activate":
      if (!ACTIVATABLE_OBSERVED.has(current.observedState)) {
        return {
          allowed: false,
          reason: `activate not allowed from observed state ${current.observedState}`,
        };
      }
      return {
        allowed: true,
        target: {
          desiredState: "active",
          observedState: "active",
          healthState: "unknown",
        },
      };
    case "disable":
      if (
        !DISABLEABLE_OBSERVED.has(current.observedState) &&
        current.desiredState !== "active"
      ) {
        return {
          allowed: false,
          reason: `disable not allowed from observed state ${current.observedState}`,
        };
      }
      return {
        allowed: true,
        target: {
          desiredState: "disabled",
          observedState: "configured",
        },
      };
    case "upgrade":
      if (!UPGRADEABLE_OBSERVED.has(current.observedState)) {
        return {
          allowed: false,
          reason: `upgrade not allowed from observed state ${current.observedState}`,
        };
      }
      return {
        allowed: true,
        target: {
          desiredState: current.desiredState,
          observedState:
            current.desiredState === "active" ? "active" : "configured",
          healthState: "unknown",
        },
      };
    case "rollback":
      if (!ROLLBACKABLE_OBSERVED.has(current.observedState)) {
        return {
          allowed: false,
          reason: `rollback not allowed from observed state ${current.observedState}`,
        };
      }
      return {
        allowed: true,
        target: {
          desiredState: current.desiredState,
          observedState:
            current.desiredState === "active" ? "active" : "configured",
          healthState: "unknown",
        },
      };
    case "uninstall":
      if (!UNINSTALLABLE_OBSERVED.has(current.observedState)) {
        return {
          allowed: false,
          reason: `uninstall not allowed from observed state ${current.observedState}`,
        };
      }
      return {
        allowed: true,
        target: {
          desiredState: "removed",
          observedState: "removed",
          healthState: "unknown",
        },
      };
  }
}

const OPERATION_STATE_TRANSITIONS: Record<
  SolutionOperationState,
  ReadonlySet<SolutionOperationState>
> = {
  queued: new Set(["claimed", "cancelled", "failed"]),
  claimed: new Set(["running", "failed", "succeeded", "cancelled"]),
  running: new Set(["succeeded", "failed"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function canTransitionOperationState(
  from: SolutionOperationState,
  to: SolutionOperationState,
): boolean {
  return OPERATION_STATE_TRANSITIONS[from].has(to);
}

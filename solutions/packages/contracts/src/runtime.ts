/**
 * Runtime、工具与 Solution 状态契约。
 */

export interface ToolObservation {
  tool: string;
  status: "success" | "failure" | "timeout" | "unknown";
  result?: unknown;
  operationId?: string;
  startedAt?: string;
  completedAt?: string;
}

export type RuntimeComponent =
  | "core"
  | "console"
  | "agent-worker"
  | "ingestion-worker"
  | "solution-runner"
  | "weflowctl";

export type RuntimeComponentState =
  | "starting"
  | "ready"
  | "degraded"
  | "stopped"
  | "unknown";

export interface RuntimeStatus {
  component: RuntimeComponent;
  state: RuntimeComponentState;
  version?: string;
  lastHeartbeatAt?: string;
}

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

export type SolutionHealthState = "unknown" | "healthy" | "degraded" | "unhealthy";

export interface SolutionInstallationState {
  solutionId: string;
  version: string;
  desiredState: DesiredSolutionState;
  observedState: ObservedSolutionState;
  healthState: SolutionHealthState;
}

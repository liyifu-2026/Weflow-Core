import type {
  RuntimeStatus,
  SolutionInstallationState,
} from "@weflow-leaif/contracts";

export interface SolutionSummary extends SolutionInstallationState {
  name: string;
  publisher: string;
}

export interface SolutionDetail extends SolutionSummary {
  compatibility: {
    platform: string;
    pluginSdk?: string;
  };
  permissions: string[];
  secretsConfigured: string[];
  recentOperations: SolutionOperation[];
  rollbackVersion?: string | null;
}

export type SolutionOperationType =
  | "install"
  | "configure"
  | "activate"
  | "disable"
  | "upgrade"
  | "rollback"
  | "uninstall";

export type SolutionOperationState =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface SolutionOperation {
  operationId: string;
  solutionId: string;
  type: SolutionOperationType;
  state: SolutionOperationState;
  idempotencyKey: string;
  planDigest?: string;
  attempt: number;
  claimedAt?: string;
  leaseUntil?: string;
  checkpoint?: string;
  errorCode?: string;
  actor: string;
  createdAt?: string;
}

export interface CreateSolutionOperationInput {
  solutionId: string;
  type: SolutionOperationType;
  idempotencyKey: string;
  planDigest?: string;
}

export interface AdminClient {
  listSolutions(): Promise<SolutionSummary[]>;
  getSolution(solutionId: string): Promise<SolutionDetail>;
  createSolutionOperation(
    input: CreateSolutionOperationInput,
  ): Promise<SolutionOperation>;
  getRuntimeStatus(): Promise<RuntimeStatus[]>;
}

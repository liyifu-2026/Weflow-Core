import type {
  AgentAction,
  AgentExecutionStrategy,
  RuntimeStatus,
  SolutionInstallationState,
} from "@weflow/contracts";
import type {
  PluginDefinition,
  RuntimePluginManifest,
  ToolRegistration,
} from "@weflow/plugin-sdk";
import type {
  AdminClient,
  SolutionOperation,
  SolutionSummary,
} from "@weflow/admin-sdk";

export type {
  AgentAction,
  AgentExecutionStrategy,
  RuntimeStatus,
  SolutionInstallationState,
  PluginDefinition,
  RuntimePluginManifest,
  ToolRegistration,
  AdminClient,
  SolutionOperation,
  SolutionSummary,
};

export function buildSampleTypes(): {
  action: AgentAction;
  plugin: RuntimePluginManifest;
  admin: AdminClient;
} {
  const action: AgentAction = {
    kind: "no_action",
    reasonCode: "waiting_for_user",
  };
  const plugin: RuntimePluginManifest = {
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
  const admin: AdminClient = {
    listSolutions: async () => [],
    getSolution: async () => {
      throw new Error("not implemented");
    },
    createSolutionOperation: async () => {
      throw new Error("not implemented");
    },
    getRuntimeStatus: async () => [],
  };
  return { action, plugin, admin };
}

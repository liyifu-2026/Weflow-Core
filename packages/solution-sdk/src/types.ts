/**
 * Solution Pack Foundation 的公共类型。
 *
 * 这些类型是 Phase 7 的稳定契约，后续 Solution Runner、Console 与 weflowctl
 * 都应只通过这些公开类型和校验器访问 Solution 包。
 */

export interface SolutionMetadata {
  id: string;
  name: string;
  version: string;
  publisher: string;
}

export interface SolutionCompatibility {
  platform: string;
  pluginSdk?: string;
}

export interface SolutionDependencies {
  capabilities: string[];
  solutions: string[];
}

export type ArtifactType = "plugin" | "app" | "container" | "resource";

export interface SolutionArtifact {
  id: string;
  type: ArtifactType;
  ref: string;
  digest?: string;
  size?: number;
}

export type PermissionAction = "read" | "write" | "execute" | "admin";

export interface SolutionPermission {
  id: string;
  resource: string;
  action: PermissionAction;
  description?: string;
}

export interface SecretSlot {
  name: string;
  kind: "env" | "file";
  required: boolean;
  description?: string;
}

export type SolutionResourceType =
  | "schema"
  | "ledger"
  | "role"
  | "agent-definition"
  | "policy"
  | "evaluation"
  | "knowledge-template";

export interface SolutionResource {
  id: string;
  type: SolutionResourceType;
  ref: string;
}

export interface ExecutionProfileSkillRef {
  id: string;
  version?: string;
}

export interface ExecutionProfile {
  id: string;
  strategyRef: string;
  maxModelCalls: number;
  maxToolCalls: number;
  timeoutSeconds: number;
  allowedTools: string[];
  skills: ExecutionProfileSkillRef[];
}

export type SolutionApplicationType = "web" | "bff" | "mobile" | "worker";

export interface SolutionApplication {
  id: string;
  type: SolutionApplicationType;
  entry: string;
}

export interface ConsoleExtensionNav {
  group?: string;
  label: string;
  icon?: string;
  order?: number;
}

export type SettingFieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "secret";

export interface SettingFieldOption {
  label: string;
  value: string;
}

export interface SettingField {
  key: string;
  label: string;
  type: SettingFieldType;
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  options?: SettingFieldOption[];
}

export type SettingCategory = "general" | "integrations" | "security" | "advanced";

export interface SettingContribution {
  id: string;
  category: SettingCategory;
  label: string;
  component?: string;
  order?: number;
  schema?: SettingField[];
}

export interface DashboardPosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardContribution {
  id: string;
  title: string;
  component?: string;
  defaultPosition?: DashboardPosition;
  refreshInterval?: number;
  api?: string;
}

export interface PluginApiRoute {
  prefix: string;
  target: string;
}

export interface ConsoleExtension {
  id: string;
  title: string;
  entry?: string;
  nav?: ConsoleExtensionNav;
  settings?: boolean;
  dashboard?: boolean;
  settingsSchema?: SettingField[];
  settingsContributions?: SettingContribution[];
  dashboardContributions?: DashboardContribution[];
  apiRoutes?: PluginApiRoute[];
  eventSubscriptions?: string[];
}

export type HealthCheckType = "http" | "tcp" | "process";

export interface HealthCheck {
  id: string;
  type: HealthCheckType;
  target: string;
  timeoutSeconds?: number;
}

export interface SolutionBackend {
  entry: string;
}

export interface SolutionManifestV1 {
  apiVersion: "weflow.io/v1";
  kind: "Solution";
  metadata: SolutionMetadata;
  compatibility: SolutionCompatibility;
  dependencies: SolutionDependencies;
  artifacts: SolutionArtifact[];
  permissions: SolutionPermission[];
  configuration: Record<string, unknown>;
  secretSlots: SecretSlot[];
  resources: SolutionResource[];
  executionProfiles: ExecutionProfile[];
  applications: SolutionApplication[];
  healthChecks: HealthCheck[];
  backend?: SolutionBackend;
  consoleExtensions?: ConsoleExtension[];
}

export interface LockedDependency {
  id: string;
  version: string;
  registry?: string;
  digest: string;
}

export interface LockedArtifact {
  id: string;
  ref: string;
  registry?: string;
  digest: string;
  size?: number;
  platform?: string;
  architecture?: string;
}

export interface SolutionLockV1 {
  apiVersion: "weflow.io/v1";
  kind: "SolutionLock";
  solutionId: string;
  solutionVersion: string;
  manifestDigest: string;
  dependencies: LockedDependency[];
  artifacts: LockedArtifact[];
  targetPlatform?: string;
  targetArchitecture?: string;
  sbom?: string;
}

export interface SolutionSignature {
  algorithm: "ed25519";
  keyId: string;
  digest: string;
  signature: string;
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

export interface InstalledSolution {
  id: string;
  version: string;
  desiredState: DesiredSolutionState;
  observedState: ObservedSolutionState;
  healthState: SolutionHealthState;
}

export interface CapabilityEntry {
  id: string;
  providedBy: string;
  version: string;
}

export interface ArtifactCatalogEntry {
  id: string;
  ref: string;
  registry: string;
  digest: string;
}

export interface SecretInventory {
  configured: string[];
}

export interface RuntimeState {
  processes: string[];
  available: boolean;
}

export interface SolutionDescriptor {
  manifest: SolutionManifestV1;
  lock: SolutionLockV1;
}

export interface PlannerInput {
  descriptor: SolutionDescriptor;
  platformVersion: string;
  pluginSdkVersion?: string;
  installedSolutions: InstalledSolution[];
  capabilityCatalog: CapabilityEntry[];
  artifactCatalog: ArtifactCatalogEntry[];
  secretInventory: SecretInventory;
  runtimeState: RuntimeState;
}

export interface CompatibilityResult {
  compatible: boolean;
  platformRange: string;
  platformVersion: string;
  pluginSdkRange?: string;
  reason?: string;
}

export interface CapabilityConflict {
  capability: string;
  existingProvider: string;
  requestedProvider?: string;
}

export interface ArtifactDownload {
  id: string;
  ref: string;
  registry: string;
  digest: string;
}

export interface SolutionMigration {
  id: string;
  schema: string;
  digest: string;
}

export interface ResourceChange {
  id: string;
  type: SolutionResourceType;
  action: "create" | "update" | "archive";
}

export interface Blocker {
  code: string;
  message: string;
}

export interface InstallPlan {
  planDigest: string;
  solutionId: string;
  solutionVersion: string;
  compatibility: CompatibilityResult;
  dependencyOrder: string[];
  capabilityConflicts: CapabilityConflict[];
  permissionAdditions: SolutionPermission[];
  missingSecrets: string[];
  artifactDownloads: ArtifactDownload[];
  migrations: SolutionMigration[];
  restartProcesses: string[];
  resources: ResourceChange[];
  healthChecks: HealthCheck[];
  rollbackVersion: string | null;
  blockers: Blocker[];
}

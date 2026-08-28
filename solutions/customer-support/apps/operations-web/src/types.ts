/**
 * 运行控制台共享类型。
 *
 * 与 Core 的 `@weflow/contracts/runtime-console` 结构兼容，
 * 但作为 Solution 层的本地副本维护，避免跨仓库依赖。
 * Core 端类型定义见 `weflow/packages/contracts/src/runtime-console.ts`。
 */

export type RuntimeSettings = {
  agentEnabled: boolean;
  autoSendEnabled: boolean;
  knowledgeEnabled: boolean;
  memoryEnabled: boolean;
  visionEnabled: boolean;
  textModel: string;
  visionModel: string;
};

export type OperatorStatus = {
  channelOnline: boolean;
  agentEnabled: boolean;
  autoSendEnabled: boolean;
  queuedTurnCount: number;
  runningTurnCount: number;
  pendingHandoffCount: number;
  lastCompletedTurnAt: string | null;
};

export type SettingsChange = {
  key: string;
  previous: string;
  next: string;
};

export type AuditEvent = {
  auditId: string;
  actorUsername: string | null;
  eventType: string;
  subjectId: string | null;
  metadata: Record<string, string>;
  createdAt: string;
};

export type RuntimeConsoleResponse = {
  settings: RuntimeSettings;
  allowlists: { text: string[]; vision: string[] };
  status: OperatorStatus;
  audit: AuditEvent[];
};

export type RuntimeSettingsPatch = {
  agentEnabled?: boolean;
  autoSendEnabled?: boolean;
  knowledgeEnabled?: boolean;
  memoryEnabled?: boolean;
  visionEnabled?: boolean;
  textModel?: string;
  visionModel?: string;
};

export type RuntimeSettingsUpdateResponse = {
  settings: RuntimeSettings;
  changed: SettingsChange[];
};

export type RuntimeSettingsRollbackResponse = {
  settings: RuntimeSettings;
  rolledBack: SettingsChange[];
};

export type RuntimeSettingsResponse = {
  settings: RuntimeSettings;
  allowlists: { text: string[]; vision: string[] };
};

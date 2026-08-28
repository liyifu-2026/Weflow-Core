/**
 * Operator Control Plane — 运行控制台 API 契约。
 *
 * 这些是 Core 的 `/api/v1/admin/runtime-console`、
 * `/api/v1/admin/runtime-settings` 和 `/api/v1/admin/stream`
 * 端点的 wire shape。Solution 层通过 ExtensionHost bridge.fetch
 * 调用这些端点时，应使用本文件定义的类型。
 *
 * 字段语义：
 * - `settings`：平台级运行时开关，所有 Solution 共享
 * - `allowlists`：平台级模型白名单，由 Core 维护
 * - `status`：实时运行状态，包含平台级和业务级指标
 * - `audit`：配置变更审计日志
 */

/** 平台级运行时设置 */
export type RuntimeSettings = {
  agentEnabled: boolean;
  autoSendEnabled: boolean;
  knowledgeEnabled: boolean;
  memoryEnabled: boolean;
  visionEnabled: boolean;
  textModel: string;
  visionModel: string;
};

/** 实时操作员状态 */
export type OperatorStatus = {
  /** Channel Host 是否在线（15 秒内有心跳） */
  channelOnline: boolean;
  /** Agent 是否启用（镜像 settings.agentEnabled） */
  agentEnabled: boolean;
  /** 自动发送是否启用（镜像 settings.autoSendEnabled） */
  autoSendEnabled: boolean;
  /** 排队中的 Agent Turn 数量 */
  queuedTurnCount: number;
  /** 运行中的 Agent Turn 数量 */
  runningTurnCount: number;
  /** 待处理的 Handoff 数量（业务层关心） */
  pendingHandoffCount: number;
  /** 最近一次完成的 Agent Turn 时间 */
  lastCompletedTurnAt: string | null;
};

/** 配置变更记录 */
export type SettingsChange = {
  key: string;
  previous: string;
  next: string;
};

/** 审计事件行 */
export type AuditEvent = {
  auditId: string;
  actorUsername: string | null;
  eventType: string;
  subjectId: string | null;
  metadata: Record<string, string>;
  createdAt: string;
};

/**
 * `GET /api/v1/admin/runtime-console` 的响应。
 * 同时也是 `GET /api/v1/admin/stream` SSE 事件 `runtime` 的 data shape。
 */
export type RuntimeConsoleResponse = {
  settings: RuntimeSettings;
  allowlists: { text: string[]; vision: string[] };
  status: OperatorStatus;
  audit: AuditEvent[];
};

/** `PATCH /api/v1/admin/runtime-settings` 的请求体 */
export type RuntimeSettingsPatch = {
  agentEnabled?: boolean;
  autoSendEnabled?: boolean;
  knowledgeEnabled?: boolean;
  memoryEnabled?: boolean;
  visionEnabled?: boolean;
  textModel?: string;
  visionModel?: string;
};

/** `PATCH /api/v1/admin/runtime-settings` 的响应 */
export type RuntimeSettingsUpdateResponse = {
  settings: RuntimeSettings;
  changed: SettingsChange[];
};

/** `POST /api/v1/admin/runtime-settings/rollback` 的响应 */
export type RuntimeSettingsRollbackResponse = {
  settings: RuntimeSettings;
  rolledBack: SettingsChange[];
};

/** `GET /api/v1/admin/runtime-settings` 的响应 */
export type RuntimeSettingsResponse = {
  settings: RuntimeSettings;
  allowlists: { text: string[]; vision: string[] };
};

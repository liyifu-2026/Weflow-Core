/**
 * PostgreSQL 数据库 Schema 定义
 * 使用 Drizzle ORM 定义所有业务表结构，包括：
 * - systemSchema: 系统运行时元数据
 * - conversationSchema: 会话、消息、联系人等核心业务表
 * - agentSchema: Agent 轮次、工具执行、回复策略
 * - handoffSchema: 人工转接流程
 * - collaborationSchema: 协作队列和请求
 * - knowledgeSchema: 知识库检索和草稿
 * - fileStorageSchema: 文件存储元数据
 * - mediaSchema: 媒体资产处理状态
 * - memorySchema: 记忆捕获和存储
 * - identitySchema: 用户身份和会话
 * - notificationSchema: 推送通知设备和发件箱
 * - auditSchema: 审计事件
 */
import { jsonb, pgSchema, timestamp, varchar } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  index,
  integer,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** 系统运行时元数据 Schema */
export const systemSchema = pgSchema("weflow_system");

export const runtimeMetadata = systemSchema.table("runtime_metadata", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: varchar("value", { length: 500 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const solutionSchema = pgSchema("solution");

export const solutionInstallations = solutionSchema.table("installations", {
  solutionId: varchar("solution_id", { length: 200 }).primaryKey(),
  version: varchar("version", { length: 50 }).notNull(),
  desiredState: varchar("desired_state", { length: 20 })
    .default("disabled")
    .notNull(),
  observedState: varchar("observed_state", { length: 20 })
    .default("absent")
    .notNull(),
  healthState: varchar("health_state", { length: 20 })
    .default("unknown")
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const solutionVersions = solutionSchema.table(
  "versions",
  {
    solutionId: varchar("solution_id", { length: 200 }).notNull(),
    version: varchar("version", { length: 50 }).notNull(),
    manifestDigest: varchar("manifest_digest", { length: 80 }).notNull(),
    lockDigest: varchar("lock_digest", { length: 80 }).notNull(),
    signatureKeyId: varchar("signature_key_id", { length: 200 }),
    status: varchar("status", { length: 20 }).default("installed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.solutionId, table.version] })],
);

export const solutionOperations = solutionSchema.table(
  "operations",
  {
    operationId: varchar("operation_id", { length: 100 }).primaryKey(),
    solutionId: varchar("solution_id", { length: 200 }).notNull(),
    type: varchar("type", { length: 20 }).notNull(),
    state: varchar("state", { length: 20 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    planDigest: varchar("plan_digest", { length: 80 }),
    attempt: integer("attempt").default(0).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    checkpoint: varchar("checkpoint", { length: 200 }),
    errorCode: varchar("error_code", { length: 100 }),
    actor: varchar("actor", { length: 200 }).notNull(),
    runnerId: varchar("runner_id", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("solution_operations_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    index("solution_operations_state_idx").on(table.state),
    index("solution_operations_solution_idx").on(table.solutionId),
  ],
);

export const solutionOperationPayloads = solutionSchema.table(
  "operation_payloads",
  {
    operationId: varchar("operation_id", { length: 100 })
      .primaryKey()
      .references(() => solutionOperations.operationId, {
        onDelete: "cascade",
      }),
    manifestJson: jsonb("manifest_json")
      .$type<Record<string, unknown>>()
      .notNull(),
    lockJson: jsonb("lock_json").$type<Record<string, unknown>>().notNull(),
    signatureJson: jsonb("signature_json")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

export const solutionResourceOwnership = solutionSchema.table(
  "resource_ownership",
  {
    resourceId: varchar("resource_id", { length: 300 }).notNull(),
    solutionId: varchar("solution_id", { length: 200 }).notNull(),
    resourceType: varchar("resource_type", { length: 50 }).notNull(),
    resourceRef: varchar("resource_ref", { length: 500 }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.resourceId, table.solutionId] })],
);

export const solutionEvents = solutionSchema.table(
  "events",
  {
    eventId: varchar("event_id", { length: 100 }).primaryKey(),
    solutionId: varchar("solution_id", { length: 200 }).notNull(),
    operationId: varchar("operation_id", { length: 100 }),
    eventType: varchar("event_type", { length: 60 }).notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("solution_events_solution_created_idx").on(
      table.solutionId,
      table.createdAt,
    ),
  ],
);

export const solutionSecretAssignments = solutionSchema.table(
  "secret_assignments",
  {
    solutionId: varchar("solution_id", { length: 200 })
      .notNull()
      .references(() => solutionInstallations.solutionId, {
        onDelete: "cascade",
      }),
    slotName: varchar("slot_name", { length: 200 }).notNull(),
    refType: varchar("ref_type", { length: 20 }).notNull(),
    refValue: varchar("ref_value", { length: 1000 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.solutionId, table.slotName] })],
);

export const solutionExtensionSettings = solutionSchema.table(
  "extension_settings",
  {
    solutionId: varchar("solution_id", { length: 200 })
      .notNull()
      .references(() => solutionInstallations.solutionId, {
        onDelete: "cascade",
      }),
    extensionId: varchar("extension_id", { length: 200 }).notNull(),
    settingsJson: jsonb("settings_json")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    updatedBy: varchar("updated_by", { length: 200 }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.solutionId, table.extensionId] })],
);

export const conversationSchema = pgSchema("conversation");

export const contactProfiles = conversationSchema.table(
  "contact_profiles",
  {
    contactId: varchar("contact_id", { length: 600 }).primaryKey(),
    channel: varchar("channel", { length: 50 }).notNull(),
    /** 账号维度（多微信账号隔离，ADR-0005）；缺省 "default" */
    channelAccount: varchar("channel_account", { length: 64 })
      .default("default")
      .notNull(),
    channelContactId: varchar("channel_contact_id", {
      length: 256,
    }).notNull(),
    channelDisplayName: text("channel_display_name"),
    channelNickname: text("channel_nickname"),
    channelRemark: text("channel_remark"),
    channelAlias: text("channel_alias"),
    avatarUrl: text("avatar_url"),
    sharedAlias: text("shared_alias"),
    aliasUpdatedByUserId: varchar("alias_updated_by_user_id", { length: 36 }),
    aliasUpdatedAt: timestamp("alias_updated_at", { withTimezone: true }),
    note: text("note"),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    // 白名单开关：false = 该联系人不触发 Agent 对话（人工处理）；默认开启（所有用户默认白名单，ADR-0060）
    agentEnabled: boolean("agent_enabled").default(true).notNull(),
    // 黑名单：true = 不建 Agent Turn、不出现在会话列表、不推通知；消息照常入库，
    // 只能在联系人页查看（比 agentEnabled=false 更强的隔离）。
    blocked: boolean("blocked").default(false).notNull(),
    updatedByUserId: varchar("updated_by_user_id", { length: 36 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("contact_profiles_channel_identity_unique").on(
      table.channel,
      table.channelAccount,
      table.channelContactId,
    ),
  ],
);

export const contactAliasEvents = conversationSchema.table(
  "contact_alias_events",
  {
    eventId: varchar("event_id", { length: 36 }).primaryKey(),
    contactId: varchar("contact_id", { length: 600 })
      .notNull()
      .references(() => contactProfiles.contactId, { onDelete: "cascade" }),
    actorUserId: varchar("actor_user_id", { length: 36 })
      .notNull()
      .references(() => users.userId),
    previousAlias: text("previous_alias"),
    nextAlias: text("next_alias"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("contact_alias_events_contact_created_idx").on(
      table.contactId,
      table.createdAt,
    ),
  ],
);

export const channelCursors = conversationSchema.table("channel_cursors", {
  source: varchar("source", { length: 50 }).primaryKey(),
  cursor: bigint("cursor", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const conversations = conversationSchema.table("conversations", {
  conversationId: varchar("conversation_id", { length: 300 }).primaryKey(),
  contactId: varchar("contact_id", { length: 600 })
    .notNull()
    .references(() => contactProfiles.contactId),
  channel: varchar("channel", { length: 50 }).notNull(),
  /** 账号维度（多微信账号隔离，ADR-0005）；缺省 "default" */
  channelAccount: varchar("channel_account", { length: 64 })
    .default("default")
    .notNull(),
  channelConversationId: varchar("channel_conversation_id", {
    length: 256,
  }).notNull(),
  revision: integer("revision").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const messages = conversationSchema.table(
  "messages",
  {
    messageId: varchar("message_id", { length: 600 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    channelEventId: varchar("channel_event_id", { length: 600 }),
    channelMessageId: varchar("channel_message_id", {
      length: 300,
    }),
    direction: varchar("direction", { length: 20 }).notNull(),
    actorType: varchar("actor_type", { length: 30 }).notNull(),
    actorId: varchar("actor_id", { length: 256 }),
    contentType: varchar("content_type", { length: 50 }).notNull(),
    channelType: integer("channel_type").notNull(),
    text: text("text").notNull(),
    isSelf: boolean("is_self"),
    processingState: varchar("processing_state", { length: 30 }).notNull(),
    sendState: varchar("send_state", { length: 30 }),
    sendOperationId: varchar("send_operation_id", { length: 128 }),
    sendError: text("send_error"),
    sendUpdatedAt: timestamp("send_updated_at", { withTimezone: true }),
    replyBatchId: varchar("reply_batch_id", { length: 700 }),
    replySequence: integer("reply_sequence"),
    /** 引用回复的原通道消息（ADR-0006 群聊引用） */
    replyToChannelMessageId: varchar("reply_to_channel_message_id", {
      length: 300,
    }),
    /** @ 提及的通道联系人（ADR-0006 群聊 @），默认空数组 */
    mentionContactRefs: jsonb("mention_contact_refs")
      .$type<string[]>()
      .default([])
      .notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 600 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    traceId: varchar("trace_id", { length: 700 }).notNull(),
  },
  (table) => [
    unique("messages_channel_event_unique").on(table.channelEventId),
    unique("messages_channel_message_unique").on(
      table.conversationId,
      table.channelMessageId,
    ),
    index("messages_conversation_occurred_idx").on(
      table.conversationId,
      table.occurredAt,
    ),
    index("messages_reply_batch_idx").on(
      table.replyBatchId,
      table.replySequence,
    ),
  ],
);

export const agentSchema = pgSchema("agent");

export const replyPolicyVersions = agentSchema.table(
  "reply_policy_versions",
  {
    policyVersionId: varchar("policy_version_id", { length: 36 }).primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    version: integer("version").notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
    publishedByUserId: varchar("published_by_user_id", { length: 36 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    unique("reply_policy_versions_name_version_unique").on(
      table.name,
      table.version,
    ),
    index("reply_policy_versions_status_idx").on(table.status),
  ],
);

export const agentExecutionProfiles = agentSchema.table(
  "execution_profiles",
  {
    profileId: varchar("profile_id", { length: 100 }).primaryKey(),
    solutionId: varchar("solution_id", { length: 200 }).notNull(),
    solutionVersion: varchar("solution_version", { length: 50 }).notNull(),
    strategyRef: varchar("strategy_ref", { length: 200 }).notNull(),
    strategyVersion: varchar("strategy_version", { length: 50 }).notNull(),
    maxModelCalls: integer("max_model_calls").default(2).notNull(),
    maxToolCalls: integer("max_tool_calls").default(1).notNull(),
    timeoutSeconds: integer("timeout_seconds").default(60).notNull(),
    allowedTools: jsonb("allowed_tools")
      .$type<string[]>()
      .default([])
      .notNull(),
    skills: jsonb("skills")
      .$type<{ id: string; version?: string }[]>()
      .default([])
      .notNull(),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("agent_execution_profiles_status_idx").on(table.status)],
);

export const agentTurns = agentSchema.table(
  "turns",
  {
    turnId: varchar("turn_id", { length: 700 }).primaryKey(),
    triggerMessageId: varchar("trigger_message_id", { length: 600 })
      .notNull()
      .references(() => messages.messageId),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    status: varchar("status", { length: 30 }).notNull(),
    model: varchar("model", { length: 100 }),
    replyPolicyVersionId: varchar("reply_policy_version_id", {
      length: 36,
    }).references(() => replyPolicyVersions.policyVersionId),
    executionProfileId: varchar("execution_profile_id", {
      length: 100,
    }).references(() => agentExecutionProfiles.profileId),
    responseText: text("response_text"),
    responseSegments: jsonb("response_segments").$type<string[]>(),
    errorCode: varchar("error_code", { length: 100 }),
    attempt: integer("attempt").default(0).notNull(),
    traceId: varchar("trace_id", { length: 700 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("agent_turns_trigger_message_unique").on(table.triggerMessageId),
    index("agent_turns_status_created_idx").on(table.status, table.createdAt),
  ],
);

/** Agent 轮次的阶段轨迹；只记录可审计业务事实，不保存模型思维链。 */
export const agentTurnEvents = agentSchema.table(
  "turn_events",
  {
    eventId: varchar("event_id", { length: 700 }).primaryKey(),
    turnId: varchar("turn_id", { length: 700 })
      .notNull()
      .references(() => agentTurns.turnId, { onDelete: "cascade" }),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    eventType: varchar("event_type", { length: 60 }).notNull(),
    reasonCode: varchar("reason_code", { length: 120 }),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("agent_turn_events_turn_created_idx").on(
      table.turnId,
      table.createdAt,
    ),
    index("agent_turn_events_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const toolExecutions = agentSchema.table(
  "tool_executions",
  {
    executionId: varchar("execution_id", { length: 700 }).primaryKey(),
    turnId: varchar("turn_id", { length: 700 })
      .notNull()
      .references(() => agentTurns.turnId, { onDelete: "cascade" }),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    toolName: varchar("tool_name", { length: 80 }).notNull(),
    status: varchar("status", { length: 30 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 700 })
      .notNull()
      .unique(),
    attempt: integer("attempt").default(0).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    arguments: jsonb("arguments")
      .$type<Record<string, string>>()
      .default({})
      .notNull(),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    errorCode: varchar("error_code", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("tool_executions_turn_idx").on(table.turnId),
    index("tool_executions_status_idx").on(table.status, table.createdAt),
  ],
);

export const handoffSchema = pgSchema("handoff");

export type LegacyHandoffBriefing = {
  version: 1;
  problemSummary: string;
  confirmedFacts: Array<{ key: string; label: string; value: string }>;
  missingInformation: Array<{ key: string; label: string }>;
  unresolvedItems: string[];
  suggestedFirstReply: string;
  sourceCaseRevision: number;
  generatedAt: string;
};

export type HandoffBriefingV2 = {
  version: 2;
  problemSummary: string;
  confirmedFacts: Array<{ key: string; label: string; value: string }>;
  triedSteps: string[];
  missingInformation: Array<{ key: string; label: string }>;
  unresolvedItems: string[];
  handoffReason: string;
  suggestedNextStep: string;
  suggestedFirstReply: string;
  sourceConversationRevision: number;
  generatedAt: string;
};

export type HandoffBriefing = LegacyHandoffBriefing | HandoffBriefingV2;

export type StructuredTransferContext = HandoffBriefingV2 & {
  sourceCycleId: string;
  transferReason: string;
  transferredByUserId: string;
  targetType: "user" | "queue";
  targetId: string;
};

export type ResolutionSummary = {
  text: string;
  generatedAt: string;
  sourceConversationRevision: number;
  generationMethod: "server_rules_v1";
};

export const handoffCycles = handoffSchema.table(
  "cycles",
  {
    cycleId: varchar("cycle_id", { length: 100 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    status: varchar("status", { length: 30 }).notNull(),
    contractVersion: integer("contract_version").default(1).notNull(),
    handoffRevision: integer("handoff_revision").default(1).notNull(),
    reason: text("reason").notNull(),
    briefing: jsonb("briefing").$type<HandoffBriefing | null>(),
    transferContext: jsonb(
      "transfer_context",
    ).$type<StructuredTransferContext | null>(),
    assignedUserId: varchar("assigned_user_id", { length: 36 }),
    assignedQueueId: varchar("assigned_queue_id", { length: 36 }),
    createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
    resolvedByUserId: varchar("resolved_by_user_id", { length: 36 }),
    resolution: text("resolution"),
    result: varchar("result", { length: 40 }),
    resolutionSummary: jsonb(
      "resolution_summary",
    ).$type<ResolutionSummary | null>(),
    customerConstraints: jsonb("customer_constraints")
      .$type<string[]>()
      .default([])
      .notNull(),
    transferredByUserId: varchar("transferred_by_user_id", { length: 36 }),
    targetType: varchar("target_type", { length: 12 }),
    targetId: varchar("target_id", { length: 36 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("handoff_cycles_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const handoffStates = handoffSchema.table("states", {
  conversationId: varchar("conversation_id", { length: 300 })
    .primaryKey()
    .references(() => conversations.conversationId),
  cycleId: varchar("cycle_id", { length: 100 })
    .notNull()
    .references(() => handoffCycles.cycleId),
  status: varchar("status", { length: 30 }).notNull(),
  contractVersion: integer("contract_version").default(1).notNull(),
  handoffRevision: integer("handoff_revision").default(1).notNull(),
  reason: text("reason").notNull(),
  assignedUserId: varchar("assigned_user_id", { length: 36 }),
  assignedQueueId: varchar("assigned_queue_id", { length: 36 }),
  targetUserId: varchar("target_user_id", { length: 36 }),
  targetQueueId: varchar("target_queue_id", { length: 36 }),
  transferredAt: timestamp("transferred_at", { withTimezone: true }),
  pendingSince: timestamp("pending_since", { withTimezone: true }),
  acceptBy: timestamp("accept_by", { withTimezone: true }),
  fallbackQueueId: varchar("fallback_queue_id", { length: 36 }),
  createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
  resolvedByUserId: varchar("resolved_by_user_id", { length: 36 }),
  resolution: text("resolution"),
  result: varchar("result", { length: 40 }),
  resolutionSummary: jsonb(
    "resolution_summary",
  ).$type<ResolutionSummary | null>(),
  agentPaused: boolean("agent_paused").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const handoffEvents = handoffSchema.table(
  "events",
  {
    eventId: varchar("event_id", { length: 100 }).primaryKey(),
    cycleId: varchar("cycle_id", { length: 100 })
      .notNull()
      .references(() => handoffCycles.cycleId),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    actorUserId: varchar("actor_user_id", { length: 36 }).notNull(),
    targetUserId: varchar("target_user_id", { length: 36 }).references(
      () => users.userId,
    ),
    eventType: varchar("event_type", { length: 30 }).notNull(),
    fromStatus: varchar("from_status", { length: 30 }),
    toStatus: varchar("to_status", { length: 30 }).notNull(),
    clientRequestId: varchar("client_request_id", { length: 36 })
      .notNull()
      .unique(),
    requestHash: varchar("request_hash", { length: 64 }),
    responseSnapshot: jsonb("response_snapshot").$type<Record<
      string,
      unknown
    > | null>(),
    outcomeStatus: varchar("outcome_status", { length: 20 })
      .default("succeeded")
      .notNull(),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("handoff_events_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const handoffResolutionSummaryJobs = handoffSchema.table(
  "resolution_summary_jobs",
  {
    jobId: varchar("job_id", { length: 100 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    cycleId: varchar("cycle_id", { length: 100 })
      .notNull()
      .references(() => handoffCycles.cycleId),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    attempt: integer("attempt").default(0).notNull(),
    errorCode: varchar("error_code", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("handoff_resolution_jobs_status_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const handoffQualityFeedback = handoffSchema.table(
  "quality_feedback",
  {
    feedbackId: varchar("feedback_id", { length: 100 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    cycleId: varchar("cycle_id", { length: 100 })
      .notNull()
      .references(() => handoffCycles.cycleId),
    messageId: varchar("message_id", { length: 600 }).references(
      () => messages.messageId,
    ),
    actorUserId: varchar("actor_user_id", { length: 36 })
      .notNull()
      .references(() => users.userId),
    kind: varchar("kind", { length: 40 }).notNull(),
    briefVersion: integer("brief_version"),
    clientRequestId: varchar("client_request_id", { length: 36 })
      .notNull()
      .unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("handoff_quality_feedback_cycle_idx").on(
      table.cycleId,
      table.createdAt,
    ),
  ],
);

export const collaborationSchema = pgSchema("collaboration");

export const specialistQueues = collaborationSchema.table("specialist_queues", {
  queueId: varchar("queue_id", { length: 36 }).primaryKey(),
  key: varchar("key", { length: 80 }).notNull().unique(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const queueMembers = collaborationSchema.table(
  "queue_members",
  {
    membershipId: varchar("membership_id", { length: 36 }).primaryKey(),
    queueId: varchar("queue_id", { length: 36 })
      .notNull()
      .references(() => specialistQueues.queueId),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("queue_members_queue_user_unique").on(table.queueId, table.userId),
  ],
);

export const collaborationRequests = collaborationSchema.table(
  "requests",
  {
    requestId: varchar("request_id", { length: 100 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    handoffCycleId: varchar("handoff_cycle_id", { length: 100 })
      .notNull()
      .references(() => handoffCycles.cycleId),
    kind: varchar("kind", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    queueId: varchar("queue_id", { length: 36 })
      .notNull()
      .references(() => specialistQueues.queueId),
    createdByUserId: varchar("created_by_user_id", { length: 36 })
      .notNull()
      .references(() => users.userId),
    claimedByUserId: varchar("claimed_by_user_id", { length: 36 }).references(
      () => users.userId,
    ),
    reason: text("reason").notNull(),
    claimSummary: text("claim_summary").notNull(),
    resolution: text("resolution"),
    clientRequestId: varchar("client_request_id", { length: 36 })
      .notNull()
      .unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("collaboration_requests_conversation_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("collaboration_requests_queue_status_idx").on(
      table.queueId,
      table.status,
    ),
  ],
);

export const collaborationRequestParticipants = collaborationSchema.table(
  "request_participants",
  {
    participantId: varchar("participant_id", { length: 36 }).primaryKey(),
    requestId: varchar("request_id", { length: 100 })
      .notNull()
      .references(() => collaborationRequests.requestId, {
        onDelete: "cascade",
      }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (table) => [
    unique("collaboration_participants_request_user_unique").on(
      table.requestId,
      table.userId,
    ),
  ],
);

export const knowledgeSchema = pgSchema("knowledge");

export const clientKnowledgeRetrievals = knowledgeSchema.table(
  "client_retrievals",
  {
    retrievalId: varchar("retrieval_id", { length: 100 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId),
    query: text("query").notNull(),
    conversationRevision: integer("conversation_revision").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>[]>().notNull(),
    status: varchar("status", { length: 30 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("client_knowledge_retrievals_conversation_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const clientKnowledgeDrafts = knowledgeSchema.table(
  "client_drafts",
  {
    draftId: varchar("draft_id", { length: 100 }).primaryKey(),
    retrievalId: varchar("retrieval_id", { length: 100 })
      .notNull()
      .references(() => clientKnowledgeRetrievals.retrievalId),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull(),
    conversationRevision: integer("conversation_revision").notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("client_knowledge_drafts_conversation_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const clientKnowledgeThreads = knowledgeSchema.table(
  "client_threads",
  {
    threadId: varchar("thread_id", { length: 100 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", { length: 30 }).notNull(),
    scopeId: varchar("scope_id", { length: 300 }).notNull(),
    weknoraSessionId: varchar("weknora_session_id", { length: 300 }).notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("client_knowledge_threads_user_updated_idx").on(
      table.userId,
      table.updatedAt,
    ),
    index("client_knowledge_threads_user_scope_idx").on(
      table.userId,
      table.scopeType,
      table.scopeId,
    ),
  ],
);

export const clientKnowledgeThreadMessages = knowledgeSchema.table(
  "client_thread_messages",
  {
    messageId: varchar("message_id", { length: 100 }).primaryKey(),
    threadId: varchar("thread_id", { length: 100 })
      .notNull()
      .references(() => clientKnowledgeThreads.threadId, {
        onDelete: "cascade",
      }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull(),
    content: text("content").notNull(),
    references: jsonb("references")
      .$type<Record<string, unknown>[]>()
      .notNull(),
    suggestions: jsonb("suggestions")
      .$type<Record<string, unknown>[]>()
      .notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    completed: boolean("completed").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("client_knowledge_thread_messages_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
    index("client_knowledge_thread_messages_user_idx").on(table.userId),
  ],
);

export const clientKnowledgeEvidenceTrays = knowledgeSchema.table(
  "client_evidence_trays",
  {
    trayId: varchar("tray_id", { length: 100 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId, { onDelete: "cascade" }),
    evidence: jsonb("evidence").$type<Record<string, unknown>[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("client_knowledge_evidence_tray_user_conversation_unique").on(
      table.userId,
      table.conversationId,
    ),
  ],
);

export const clientKnowledgeFeedback = knowledgeSchema.table(
  "client_feedback",
  {
    feedbackId: varchar("feedback_id", { length: 100 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    conversationId: varchar("conversation_id", { length: 300 }).references(
      () => conversations.conversationId,
      { onDelete: "cascade" },
    ),
    threadId: varchar("thread_id", { length: 100 }),
    query: text("query").notNull(),
    answer: text("answer").notNull(),
    referenceIds: jsonb("reference_ids").$type<string[]>().notNull(),
    feedbackType: varchar("feedback_type", { length: 30 }).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("client_knowledge_feedback_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export const fileStorageSchema = pgSchema("file_storage");

export const storedFiles = fileStorageSchema.table("files", {
  fileId: varchar("file_id", { length: 36 }).primaryKey(),
  ownerModule: varchar("owner_module", { length: 50 }).notNull(),
  originalName: text("original_name").notNull(),
  mimeType: varchar("mime_type", { length: 200 }).notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  checksum: varchar("checksum", { length: 64 }).notNull(),
  storageKey: varchar("storage_key", { length: 200 }).notNull().unique(),
  createdByUserId: varchar("created_by_user_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const memorySchema = pgSchema("memory");

export const mediaSchema = pgSchema("media");

export const mediaAssets = mediaSchema.table(
  "assets",
  {
    mediaId: varchar("media_id", { length: 100 }).primaryKey(),
    messageId: varchar("message_id", { length: 600 })
      .notNull()
      .references(() => messages.messageId),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    sourceConversationId: varchar("source_conversation_id", {
      length: 256,
    }).notNull(),
    // Historical media may retain this numeric source key for audit. Current
    // Channel Host media uses sourceMediaRef and keeps provider IDs opaque.
    sourceLocalId: bigint("source_local_id", { mode: "number" }),
    sourceMediaRef: varchar("source_media_ref", { length: 512 }),
    kind: varchar("kind", { length: 30 }).notNull(),
    status: varchar("status", { length: 30 }).default("queued").notNull(),
    originalFileId: varchar("original_file_id", { length: 36 }).references(
      () => storedFiles.fileId,
    ),
    /** 全尺寸原图文件（高清查看/视觉描述）；未下载成功时为空，前端据此隐藏"查看原图" */
    originalImageFileId: varchar("original_image_file_id", {
      length: 36,
    }).references(() => storedFiles.fileId),
    /** Host 返回的媒体变体：thumbnail=缩略图回退（可升级原图），original/NULL=终态 */
    sourceVariant: varchar("source_variant", { length: 16 }),
    /** 缩略图→原图升级已尝试次数 */
    upgradeAttempt: integer("upgrade_attempt").default(0).notNull(),
    attempt: integer("attempt").default(0).notNull(),
    errorCode: varchar("error_code", { length: 100 }),
    description: text("description"),
    descriptionModel: varchar("description_model", { length: 100 }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("media_assets_message_unique").on(table.messageId),
    unique("media_assets_source_unique").on(
      table.sourceConversationId,
      table.sourceLocalId,
    ),
    index("media_assets_status_retry_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    index("media_assets_source_media_ref_idx").on(table.sourceMediaRef),
  ],
);

export const memoryCaptureStates = memorySchema.table(
  "capture_states",
  {
    conversationId: varchar("conversation_id", { length: 300 })
      .primaryKey()
      .references(() => conversations.conversationId),
    contactId: varchar("contact_id", { length: 600 })
      .notNull()
      .references(() => contactProfiles.contactId),
    watermarkMessageId: varchar("watermark_message_id", { length: 600 })
      .notNull()
      .references(() => messages.messageId),
    lastCapturedMessageId: varchar("last_captured_message_id", {
      length: 600,
    }).references(() => messages.messageId),
    revision: integer("revision").default(1).notNull(),
    status: varchar("status", { length: 30 }).default("scheduled").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    attempt: integer("attempt").default(0).notNull(),
    errorCode: varchar("error_code", { length: 100 }),
    extractedCount: integer("extracted_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("memory_capture_status_schedule_idx").on(
      table.status,
      table.scheduledAt,
    ),
  ],
);

export const memories = memorySchema.table(
  "memories",
  {
    memoryId: varchar("memory_id", { length: 100 }).primaryKey(),
    contactId: varchar("contact_id", { length: 600 })
      .notNull()
      .references(() => contactProfiles.contactId),
    kind: varchar("kind", { length: 30 }).notNull(),
    memoryKey: varchar("memory_key", { length: 100 }).notNull(),
    content: text("content").notNull(),
    status: varchar("status", { length: 30 }).notNull(),
    confidence: integer("confidence").notNull(),
    importance: integer("importance").notNull().default(3),
    evidenceMessageIds: jsonb("evidence_message_ids")
      .$type<string[]>()
      .notNull(),
    extractedByModel: varchar("extracted_by_model", { length: 100 }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true })
      .defaultNow()
      .notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
  },
  (table) => [
    index("memories_contact_status_idx").on(table.contactId, table.status),
    index("memories_contact_key_idx").on(
      table.contactId,
      table.kind,
      table.memoryKey,
    ),
    index("memories_contact_status_importance_idx").on(
      table.contactId,
      table.status,
      table.importance,
      table.updatedAt,
    ),
  ],
);

export const memoryEvents = memorySchema.table(
  "events",
  {
    eventId: varchar("event_id", { length: 100 }).primaryKey(),
    memoryId: varchar("memory_id", { length: 100 })
      .notNull()
      .references(() => memories.memoryId),
    actorUserId: varchar("actor_user_id", { length: 36 }),
    eventType: varchar("event_type", { length: 30 }).notNull(),
    clientRequestId: varchar("client_request_id", { length: 36 }).unique(),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("memory_events_memory_created_idx").on(
      table.memoryId,
      table.createdAt,
    ),
  ],
);

export const identitySchema = pgSchema("identity");
export const notificationSchema = pgSchema("notification");

export const users = identitySchema.table("users", {
  userId: varchar("user_id", { length: 36 }).primaryKey(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: varchar("role", { length: 20 }).default("operator").notNull(),
  mustChangePassword: boolean("must_change_password").default(true).notNull(),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  /** 客服头像（引用 file_storage.files；无头像为 null） */
  avatarFileId: varchar("avatar_file_id", { length: 36 }).references(
    () => storedFiles.fileId,
    { onDelete: "set null" },
  ),
  /** 平台预设头像 id（见 identity/avatar-presets）；优先于默认哈希头像，次于自定义上传 */
  avatarPreset: text("avatar_preset"),
  /** 信息名片显示名（可空；空 = 展示 username） */
  displayName: varchar("display_name", { length: 24 }),
  /** 客服自选专家标签（标签键 = 专家队列 key，用于转人工定向路由） */
  tags: jsonb("tags").$type<string[]>().default([]).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * WeKnora 桥接账号：weflow 用户 → WeKnora 用户的代管登录。
 * 合成密码与访问/刷新令牌均为 AES-256-GCM 密文（KNORA_ACCOUNT_ENC_KEY），
 * 会话由服务端代持，浏览器只拿一次性 code 换取短期令牌。
 */
export const knoraAccounts = identitySchema.table("knora_accounts", {
  weflowUserId: varchar("weflow_user_id", { length: 36 })
    .primaryKey()
    .references(() => users.userId, { onDelete: "cascade" }),
  knoraUserId: varchar("knora_user_id", { length: 36 }).notNull(),
  knoraEmail: varchar("knora_email", { length: 255 }).notNull().unique(),
  passwordEnc: text("password_enc").notNull(),
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  /** 缓存访问令牌的保守有效期（登录时刻 + 22h；访问令牌本身 24h） */
  tokensExpireAt: timestamp("tokens_expire_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const notificationDevices = notificationSchema.table(
  "devices",
  {
    deviceId: varchar("device_id", { length: 36 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId),
    pushToken: varchar("push_token", { length: 300 }).notNull().unique(),
    platform: varchar("platform", { length: 20 }).notNull(),
    showPreview: boolean("show_preview").default(false).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("notification_devices_user_idx").on(table.userId)],
);

export const notificationOutbox = notificationSchema.table(
  "outbox",
  {
    notificationId: varchar("notification_id", { length: 100 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId),
    kind: varchar("kind", { length: 50 }).notNull(),
    dedupeKey: varchar("dedupe_key", { length: 300 }).notNull().unique(),
    payload: jsonb("payload").$type<Record<string, string>>().notNull(),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    attempt: integer("attempt").default(0).notNull(),
    errorCode: varchar("error_code", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    index("notification_outbox_status_idx").on(table.status, table.createdAt),
  ],
);

export const conversationReadStates = conversationSchema.table(
  "read_states",
  {
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId, { onDelete: "cascade" }),
    lastReadMessageId: varchar("last_read_message_id", { length: 600 })
      .notNull()
      .references(() => messages.messageId),
    lastReadAt: timestamp("last_read_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("conversation_read_states_user_conversation_unique").on(
      table.userId,
      table.conversationId,
    ),
    index("conversation_read_states_user_idx").on(table.userId),
  ],
);

/** 用户级会话可见性：隐藏只影响当前用户，不删除共享业务数据。 */
export const conversationVisibility = conversationSchema.table(
  "conversation_visibility",
  {
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    conversationId: varchar("conversation_id", { length: 300 })
      .notNull()
      .references(() => conversations.conversationId, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("conversation_visibility_user_conversation_unique").on(
      table.userId,
      table.conversationId,
    ),
    index("conversation_visibility_user_hidden_idx").on(
      table.userId,
      table.hiddenAt,
    ),
  ],
);

export const userSessions = identitySchema.table(
  "user_sessions",
  {
    sessionId: varchar("session_id", { length: 36 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.userId),
    tokenDigest: varchar("token_digest", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("user_sessions_user_expiry_idx").on(table.userId, table.expiresAt),
  ],
);

export const auditSchema = pgSchema("audit");

export const auditEvents = auditSchema.table("events", {
  auditId: varchar("audit_id", { length: 36 }).primaryKey(),
  actorUserId: varchar("actor_user_id", { length: 36 }),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  subjectType: varchar("subject_type", { length: 50 }).notNull(),
  subjectId: varchar("subject_id", { length: 100 }),
  sourceIp: varchar("source_ip", { length: 100 }),
  metadata: jsonb("metadata").$type<Record<string, string>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const evaluationSchema = pgSchema("evaluation");

export const evaluationCases = evaluationSchema.table("cases", {
  caseId: varchar("case_id", { length: 100 }).primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  zone: varchar("zone", { length: 30 }).notNull(),
  sourceType: varchar("source_type", { length: 40 }).notNull(),
  sourceRef: text("source_ref"),
  sourceHash: varchar("source_hash", { length: 128 }),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  expected: jsonb("expected").$type<Record<string, unknown>>().notNull(),
  redactionStatus: varchar("redaction_status", { length: 30 }).notNull(),
  status: varchar("status", { length: 30 }).notNull(),
  createdByUserId: varchar("created_by_user_id", { length: 36 }).references(
    () => users.userId,
  ),
  reviewedByUserId: varchar("reviewed_by_user_id", { length: 36 }).references(
    () => users.userId,
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});

export const evaluationRuns = evaluationSchema.table("runs", {
  runId: varchar("run_id", { length: 100 }).primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  policyVersionId: varchar("policy_version_id", { length: 36 }).references(
    () => replyPolicyVersions.policyVersionId,
  ),
  zone: varchar("zone", { length: 30 }).notNull(),
  status: varchar("status", { length: 30 }).notNull(),
  summary: jsonb("summary")
    .$type<Record<string, unknown>>()
    .default({})
    .notNull(),
  createdByUserId: varchar("created_by_user_id", { length: 36 }).references(
    () => users.userId,
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  errorCode: varchar("error_code", { length: 100 }),
});

export const evaluationResults = evaluationSchema.table(
  "results",
  {
    resultId: varchar("result_id", { length: 120 }).primaryKey(),
    runId: varchar("run_id", { length: 100 })
      .notNull()
      .references(() => evaluationRuns.runId, { onDelete: "cascade" }),
    caseId: varchar("case_id", { length: 100 })
      .notNull()
      .references(() => evaluationCases.caseId),
    action: varchar("action", { length: 30 }),
    passed: boolean("passed"),
    scores: jsonb("scores")
      .$type<Record<string, number>>()
      .default({})
      .notNull(),
    failures: jsonb("failures").$type<string[]>().default([]).notNull(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("evaluation_results_run_case_unique").on(table.runId, table.caseId),
  ],
);

export const evaluationAnnotations = evaluationSchema.table("annotations", {
  annotationId: varchar("annotation_id", { length: 100 }).primaryKey(),
  resultId: varchar("result_id", { length: 120 })
    .notNull()
    .references(() => evaluationResults.resultId, { onDelete: "cascade" }),
  userId: varchar("user_id", { length: 36 })
    .notNull()
    .references(() => users.userId),
  verdict: varchar("verdict", { length: 30 }).notNull(),
  correctedAction: varchar("corrected_action", { length: 30 }),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** 运营运行时设置（Operator Control Plane）：Owner 可在不重启的情况下调整系统行为 */
export const operationsSchema = pgSchema("operations");

export const runtimeSettings = operationsSchema.table("runtime_settings", {
  key: varchar("key", { length: 50 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedBy: varchar("updated_by", { length: 100 }),
});

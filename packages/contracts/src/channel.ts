/**
 * Channel 四契约（events / media / send / contacts）——唯一权威定义。
 *
 * Core 侧 `core/modules/channel/contracts/*` 只是本文件的 re-export shim；
 * Channel Host 模拟器、Core HTTP Provider 与一致性测试都必须从这里消费，
 * 禁止在任何仓库内手抄同形 DTO。
 */

/**
 * Provider-neutral observation of a channel event.
 *
 * A cursor is opaque to Weflow. The provider owns its ordering semantics and
 * may replay an event; consumers must therefore use eventId for idempotency.
 */
export type ChannelEvent = {
  readonly eventId: string;
  readonly cursor: string;
  readonly conversationRef: string;
  /** 账号维度（多微信账号隔离，ADR-0005）。缺省/null = 平台默认账号 "default"。 */
  readonly account?: string | null;
  /**
   * 会话类型（协议 v6，ADR-0010）：Host 上报的 Channel 事实，Core ingest
   * 时定一次落 conversations.chat_type。缺省/null = 旧 Host，Core 在 ingest
   * 单点按通道约定回退推导（微信即 @chatroom 后缀）。
   */
  readonly conversationKind?: ChannelConversationKind | null;
  readonly channelMessageId?: string | null;
  readonly senderRef?: string | null;
  readonly kind: ChannelEventKind;
  readonly content: string;
  readonly mediaRef?: string | null;
  /** Provider-neutral 文件名（kind=file 时由 Channel Host 提供） */
  readonly fileName?: string | null;
  /** Provider-neutral MIME 提示（kind=file 时由 Channel Host 提供） */
  readonly mimeType?: string | null;
  readonly occurredAt?: string | null;
  readonly observedAt: string;
  readonly isSelf: boolean;
  /** 群聊中被 @ 提及（ADR-0006）；缺省/缺字段 = 未提及 */
  readonly mentioned?: boolean | null;
  /** 入站引用回复的原消息（ADR-0006）；缺省/null = 无引用 */
  readonly replyToChannelMessageId?: string | null;
  /**
   * 历史回溯事件（空库 Backfill 合成）：Core 摄取时只入库展示，
   * 绝不触发 Agent Turn / 记忆捕获 / 通知 / 媒体转写排队等任何副作用。
   * 缺省/false = 实时捕获事件（行为不变）。
   */
  readonly historical?: boolean | null;
};

export type ChannelEventsPage = {
  readonly events: readonly ChannelEvent[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
  /** Host 侧当前已分配的最高 cursor（字符串化）。
   *  供消费者检测事件库被清空/重建后编号回卷到自身水位之下。 */
  readonly maxCursor?: string;
  /** Host 事件库代次标识（store 重建后变化），持久化于 host_metadata。
   *  供消费者检测事件库被整体换新（即使 cursor 恰好对齐）。 */
  readonly epoch?: string;
};

export type PullChannelEventsInput = {
  readonly afterCursor?: string;
  readonly limit?: number;
};

export interface ChannelEventSource {
  pullEvents(input: PullChannelEventsInput): Promise<ChannelEventsPage>;
}

/** Host 侧媒体变体：thumbnail 表示缩略图回退，密钥就绪后可升级原图。 */
export type ChannelMediaVariant = "original" | "thumbnail";

export type ChannelMediaResult =
  | {
      readonly state: "ready";
      readonly body: ReadableStream<Uint8Array>;
      readonly mimeType: string;
      /** Host 上报的原始文件名（Content-Disposition / 事件 fileName）；缺省未知 */
      readonly fileName?: string | null;
      /** 缺省视为 original（兼容未上报变体的 Host） */
      readonly variant?: ChannelMediaVariant;
    }
  | { readonly state: "pending" }
  | { readonly state: "not_found" }
  | { readonly state: "failed"; readonly errorCode: string };

export interface ChannelMediaSource {
  resolveImage(mediaRef: string): Promise<ChannelMediaResult>;
  /** 文件附件（kind=file）走同一 media 端点，但不做图片 MIME 白名单限制。 */
  resolveFile(mediaRef: string): Promise<ChannelMediaResult>;
  /** 语音（kind=voice）走同一 media 端点；Host 只提供其声明支持的音频格式。 */
  resolveAudio(mediaRef: string): Promise<ChannelMediaResult>;
  /** 视频（kind=video）走同一 media 端点；Host 返回 video/mp4。 */
  resolveVideo?(mediaRef: string): Promise<ChannelMediaResult>;
}

export type ChannelSendPayload =
  | {
      readonly kind: "text";
      readonly text: string;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly fileName?: string;
    }
  | {
      readonly kind: "image";
      readonly path: string;
    }
  | {
      readonly kind: "reply";
      readonly text: string;
      readonly replyToChannelMessageId: string;
    }
  | {
      readonly kind: "mention";
      readonly text: string;
      readonly mentionContactRefs: readonly string[];
    }
  | {
      readonly kind: "poke";
    }
  | {
      /** 撤回最后一条己方消息（2 分钟窗口由微信判定） */
      readonly kind: "recall";
    };

// executing 是 Channel Host 的中间态（已认领、GUI 发送中），
// 对 Core 语义等价于 pending；对账时必须能解析，否则 outbound cycle 中断。
export type ChannelSendOperationState =
  | "pending"
  | "executing"
  | "confirmed"
  | "unknown"
  | "failed";

export type ChannelSendOperation = {
  readonly operationId: string;
  readonly conversationRef: string;
  readonly payload: ChannelSendPayload;
  readonly state: ChannelSendOperationState;
  readonly error?: string;
  readonly channelMessageId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CreateChannelSendOperationInput = {
  readonly operationId: string;
  readonly conversationRef: string;
  /** 账号维度（多微信账号隔离，ADR-0005）；缺省 = 平台默认账号 "default" */
  readonly account?: string | null;
  readonly payload: ChannelSendPayload;
};

export interface ChannelSendOperations {
  create(input: CreateChannelSendOperationInput): Promise<ChannelSendOperation>;
  get(operationId: string): Promise<ChannelSendOperation | undefined>;
}

/**
 * Host 明确拒收（HTTP 4xx）：请求本身无效（协议字段缺失/非法、账号不匹配等），
 * 原样重试无意义。出站循环收到此错误应将当前消息标记 failed 并继续处理
 * 后续消息；传输类故障（超时、5xx、网络不可达）仍应中断整轮等待重试，
 * 防止一条无效消息队头堵塞冻结整个出站队列。
 */
export class ChannelSendRejectedError extends Error {
  public constructor(
    public readonly httpStatus: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChannelSendRejectedError";
  }
}

/**
 * Formal Channel contacts seam.
 *
 * Contact references and cursors are opaque to Core. A provider may derive
 * them from a local database, a remote API, or another channel-specific
 * identity store, but Core only consumes the normalized profile fields.
 */
export type ChannelContact = {
  readonly contactRef: string;
  /** 账号维度（多微信账号隔离，ADR-0005）。缺省/null = 平台默认账号 "default"。 */
  readonly account?: string | null;
  readonly displayName: string;
  readonly nickname: string | null;
  readonly remark: string | null;
  readonly alias: string | null;
  readonly avatarUrl: string | null;
  readonly contactType: string;
};

export type ChannelContactsPage = {
  readonly contacts: readonly ChannelContact[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
};

export interface ChannelContactSource {
  pullContacts(input: {
    afterCursor?: string;
    limit?: number;
  }): Promise<ChannelContactsPage>;
}

/**
 * Channel 协议快照 —— 跨语言（Core TS / Host Python）对齐的单一权威。
 * 由 weflow/scripts/sync-channel-protocol.ts 生成 host 侧 channel_protocol.py，
 * 禁止在 Python 侧手抄本快照中的任何字面量。
 *
 * 行为绑定（ADR-0010）：Core zod 校验与 Host 校验/存储都从本快照（或其生成
 * 文件）派生——消费方一律 import 常量，禁止手抄枚举。
 */
export const CHANNEL_PROTOCOL = {
  /**
   * 协议版本：任何枚举/错误码变更都必须递增。
   * v6：errorCodes 补全为真实全集（HTTP 层 8 码 + 发送层 payload/对账码）；
   *      新增 eventKinds（入站事件 kind 全集，原为无权威的隐式契约）；
   *      ChannelEvent 新增可选 conversationKind（Host 上报会话类型，
   *      Core 落库为 chat_type 事实，@chatroom 后缀知识收敛至 Host 与
   *      Core ingest 回退单点）；新增 inFlightSendOperationStates
   *      （终态 = 补集的派生依据）。
   * v5：移除出站受限 `voice` 转发（PC 微信无语音条转发入口，.silk 以文件发送
   *      接收方无法播放，功能裁剪）；入站 kind=voice SILK 事件与 media 拉取不变。
   * v4：出站新增 `recall`（撤回最后一条己方消息，2 分钟窗口）；
   *      入站 `ChannelEvent.kind` 新增 `video`（local_type 43，video/mp4 落盘）。
   * v3：移除未实现的出站 `voice` 发送能力（仅保留入站 `kind=voice` SILK 语音事件与 audio/x-silk 媒体拉取）。
   * v2：ChannelEvent 新增可选 `historical` 标记（空库 Backfill 回溯事件）。
   */
  protocolVersion: 6,
  sendOperationStates: [
    "pending",
    "executing",
    "confirmed",
    "unknown",
    "failed",
  ] as const,
  /** 在途（非终态）send operation 状态；终态 = sendOperationStates 补集 */
  inFlightSendOperationStates: ["pending", "executing"] as const,
  sendKinds: [
    "text",
    "file",
    "image",
    "reply",
    "mention",
    "poke",
    "recall",
  ] as const,
  /** 入站事件 kind 全集（Host 产出，Core 校验消费；v6 起成为权威词汇） */
  eventKinds: [
    "text",
    "image",
    "file",
    "voice",
    "emotion",
    "pat",
    "video",
  ] as const,
  /** 会话类型词汇（v6；Host 上报 conversationKind，Core 落库 chat_type） */
  conversationKinds: ["private", "group"] as const,
  mediaStates: ["ready", "pending", "not_found", "failed"] as const,
  /** Host 侧可能返回的错误码全集（HTTP 层与发送层） */
  errorCodes: [
    // HTTP 层
    "send_operation_identity_conflict",
    "media_pending",
    "media_not_found",
    "not_found",
    "channel_contacts_unavailable",
    "invalid_request",
    "channel_host_error",
    "account_mismatch",
    "unauthorized",
    "media_too_large",
    "media_unreadable",
    "media_key_refresh_unavailable",
    "backfill_unavailable",
    "backfill_already_running",
    "store_not_empty",
    // 发送层（SendAttempt / 对账）
    "wechat_send_not_confirmed",
    "at_requires_at_least_one_member",
    "recall_window_expired",
    "recall_not_found",
    "recall_unsupported",
    "video_not_found",
    "reply_target_not_latest",
    "mention_member_not_found",
    "text_payload_empty",
    "image_path_required",
    "file_path_required",
    "reply_text_required",
    "mention_text_required",
    "mention_members_required",
    "invalid_sender_result",
    "malformed_send_operation",
    "malformed_text_payload_for_reconciliation",
    "missing_payload",
    "missing_send_baseline_for_reconciliation",
    "non_text_send_not_reconcilable",
    "send_not_confirmed_after_crash",
    "tickle_not_confirmed",
    "uia_driver_unavailable_for_tickle",
  ] as const,
} as const;

/** 入站事件 kind（CHANNEL_PROTOCOL.eventKinds 的成员类型） */
export type ChannelEventKind = (typeof CHANNEL_PROTOCOL)["eventKinds"][number];

/** 会话类型（Channel 事实；Core 落库为 conversations.chat_type） */
export type ChannelConversationKind =
  (typeof CHANNEL_PROTOCOL)["conversationKinds"][number];

export type ChannelProtocol = typeof CHANNEL_PROTOCOL;

export type ChannelProtocolVersion = (typeof CHANNEL_PROTOCOL)["protocolVersion"];

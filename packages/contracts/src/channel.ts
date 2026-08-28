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
  readonly channelMessageId?: string | null;
  readonly senderRef?: string | null;
  readonly kind: string;
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
    }
  | {
      /** 转发语音条：已落盘 .silk 文件路径（仅转发，不含录音） */
      readonly kind: "voice";
      readonly path: string;
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
 * 由 weflow/scripts/sync-channel-protocol.mjs 生成 host 侧 channel_protocol.py，
 * 禁止在 Python 侧手抄本快照中的任何字面量。
 */
export const CHANNEL_PROTOCOL = {
  /**
   * 协议版本：任何枚举/错误码变更都必须递增。
   * v4：出站新增 `recall`（撤回最后一条己方消息，2 分钟窗口）与受限 `voice`（转发已落盘 .silk 语音条）；
   *      入站 `ChannelEvent.kind` 新增 `video`（local_type 43，video/mp4 落盘）。
   * v3：移除未实现的出站 `voice` 发送能力（仅保留入站 `kind=voice` SILK 语音事件与 audio/x-silk 媒体拉取）。
   * v2：ChannelEvent 新增可选 `historical` 标记（空库 Backfill 回溯事件）。
   */
  protocolVersion: 4,
  sendOperationStates: [
    "pending",
    "executing",
    "confirmed",
    "unknown",
    "failed",
  ] as const,
  sendKinds: [
    "text",
    "file",
    "image",
    "reply",
    "mention",
    "poke",
    "recall",
    "voice",
  ] as const,
  mediaStates: ["ready", "pending", "not_found", "failed"] as const,
  /** Host 侧可能返回的错误码全集（HTTP 层与发送层） */
  errorCodes: [
    "send_operation_identity_conflict",
    "media_pending",
    "media_not_found",
    "not_found",
    "channel_contacts_unavailable",
    "invalid_request",
    "channel_host_error",
    "wechat_send_not_confirmed",
    "at_requires_at_least_one_member",
    "recall_window_expired",
    "recall_not_found",
    "recall_unsupported",
    "video_not_found",
    "voice_path_invalid",
    "reply_target_not_latest",
    "mention_member_not_found",
  ] as const,
} as const;

export type ChannelProtocol = typeof CHANNEL_PROTOCOL;

export type ChannelProtocolVersion = (typeof CHANNEL_PROTOCOL)["protocolVersion"];

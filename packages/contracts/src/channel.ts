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
};

export type ChannelEventsPage = {
  readonly events: readonly ChannelEvent[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
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
}

export type ChannelSendPayload =
  | {
      readonly kind: "text";
      readonly text: string;
    }
  | {
      readonly kind: "file";
      readonly fileRef: string;
      readonly fileName?: string;
    }
  | {
      readonly kind: "image" | "voice";
      readonly mediaRef: string;
    };

export type ChannelSendOperationState =
  "pending" | "confirmed" | "unknown" | "failed";

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

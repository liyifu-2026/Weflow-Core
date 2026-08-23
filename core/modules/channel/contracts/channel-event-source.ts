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

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

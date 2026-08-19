export type ChannelMediaResult =
  | {
      readonly state: "ready";
      readonly body: ReadableStream<Uint8Array>;
      readonly mimeType: string;
    }
  | { readonly state: "pending" }
  | { readonly state: "not_found" }
  | { readonly state: "failed"; readonly errorCode: string };

export interface ChannelMediaSource {
  resolveImage(mediaRef: string): Promise<ChannelMediaResult>;
}

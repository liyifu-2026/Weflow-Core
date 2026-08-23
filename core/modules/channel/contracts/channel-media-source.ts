/** Host 侧媒体变体：thumbnail 表示缩略图回退，密钥就绪后可升级原图 */
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
  /** 文件附件（kind=file）走同一 media 端点，但不做图片 MIME 白名单限制 */
  resolveFile(mediaRef: string): Promise<ChannelMediaResult>;
  /** 语音（kind=voice）走同一 media 端点；Host 只提供其声明支持的音频格式 */
  resolveAudio(mediaRef: string): Promise<ChannelMediaResult>;
}

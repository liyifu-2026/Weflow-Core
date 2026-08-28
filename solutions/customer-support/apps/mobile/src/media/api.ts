/**
 * 媒体文件 API 模块
 * 封装媒体文件的元数据查询和内容地址生成。
 * 图片内容通过带认证头的 URI 加载，不缓存到本地。
 */
import { request } from "@/api/client";
import { apiBaseUrl } from "@/api/config";
import type { MobileSession } from "@/auth/session";

/** 媒体文件元数据 */
export type MediaMetadata = {
  mediaId: string;
  conversationId: string;
  messageId: string;
  status: string;
  mimeType?: string | null;
  size?: number | null;
  /** 图片视觉描述 / 语音转写文字 */
  description?: string | null;
};

/** 获取媒体文件元数据 */
export async function getMediaMetadata(
  session: MobileSession,
  mediaId: string,
): Promise<MediaMetadata> {
  const result = await request<{ media: MediaMetadata }>(
    `/api/v1/media/${encodeURIComponent(mediaId)}`,
    { token: session.sessionToken },
  );
  return result.media;
}

/** 生成带认证头的媒体内容 URI（图片 expo-image / 音频 expo-audio 共用同一端点） */
export function getMediaContentSource(session: MobileSession, mediaId: string) {
  return {
    uri: `${apiBaseUrl}/api/v1/media/${encodeURIComponent(mediaId)}/content`,
    headers: { authorization: `Bearer ${session.sessionToken}` },
  };
}

/** 生成带认证头的原图（高清）URI，用于全屏查看 */
export function getMediaOriginalContentSource(
  session: MobileSession,
  mediaId: string,
) {
  return {
    uri: `${apiBaseUrl}/api/v1/media/${encodeURIComponent(mediaId)}/content/original`,
    headers: { authorization: `Bearer ${session.sessionToken}` },
  };
}

/** 上传媒体文件到 POST /api/v1/media，返回 mediaId 和媒体元信息 */
export async function uploadMedia(
  session: MobileSession,
  conversationId: string,
  fileUri: string,
  fileName: string,
  mimeType: string,
): Promise<{ mediaId: string; kind: "image" | "file" | "voice" }> {
  const formData = new FormData();
  formData.append("file", {
    uri: fileUri,
    name: fileName,
    type: mimeType,
  } as unknown as Blob);
  formData.append("conversationId", conversationId);

  const response = await fetch(`${apiBaseUrl}/api/v1/media`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.sessionToken}`,
      accept: "application/json",
      // FormData 会自动设置 Content-Type 及 boundary，不可手动指定
    },
    body: formData,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(payload.error ?? "media_upload_failed");
  }
  const result = (await response.json()) as {
    mediaId: string;
    kind: "image" | "file" | "voice";
  };
  return result;
}

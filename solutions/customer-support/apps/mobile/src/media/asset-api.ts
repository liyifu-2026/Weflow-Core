/**
 * 素材空间 API 模块（平台级 /api/v1/assets）。
 * 上传入空间、分页浏览（category + 搜索 + keyset 游标）、重命名、软删除；
 * 图片缩略图通过带认证头的 URI 由 expo-image 加载，不落本地缓存文件。
 */
import { request } from "@/api/client";
import { apiBaseUrl } from "@/api/config";
import type { MobileSession } from "@/auth/session";

export type AssetCategory = "image" | "file";

/** 素材元数据（服务端投影，不含内部句柄） */
export type AssetItem = {
  assetId: string;
  category: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

export type AssetListParams = {
  category?: AssetCategory;
  search?: string;
  limit?: number;
  cursor?: string;
};

/** 分页浏览素材（keyset 游标；轻量按需加载） */
export async function listAssets(
  session: MobileSession,
  params: AssetListParams,
): Promise<{ items: AssetItem[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (params.category) qs.set("category", params.category);
  if (params.search) qs.set("search", params.search);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return request<{ items: AssetItem[]; nextCursor: string | null }>(
    `/api/v1/assets${query ? `?${query}` : ""}`,
    { token: session.sessionToken },
  );
}

/** 上传本机文件入素材空间（multipart；返回素材元数据） */
export async function uploadAsset(
  session: MobileSession,
  fileUri: string,
  fileName: string,
  mimeType: string,
): Promise<AssetItem> {
  const formData = new FormData();
  formData.append("file", {
    uri: fileUri,
    name: fileName,
    type: mimeType,
  } as unknown as Blob);
  const response = await fetch(`${apiBaseUrl}/api/v1/assets`, {
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
    throw new Error(payload.error ?? "asset_upload_failed");
  }
  const result = (await response.json()) as { asset: AssetItem };
  return result.asset;
}

/** 重命名素材 */
export async function renameAsset(
  session: MobileSession,
  assetId: string,
  name: string,
): Promise<AssetItem> {
  const result = await request<{ asset: AssetItem }>(
    `/api/v1/assets/${encodeURIComponent(assetId)}`,
    {
      method: "PATCH",
      token: session.sessionToken,
      body: JSON.stringify({ name }),
    },
  );
  return result.asset;
}

/** 软删除素材（列表不再可见；已发送消息不受影响） */
export async function deleteAsset(
  session: MobileSession,
  assetId: string,
): Promise<void> {
  await request(`/api/v1/assets/${encodeURIComponent(assetId)}`, {
    method: "DELETE",
    token: session.sessionToken,
  });
}

/** 带认证头的素材内容 URI（缩略图/预览共用；expo-image 支持 headers） */
export function assetContentSource(session: MobileSession, assetId: string) {
  return {
    uri: `${apiBaseUrl}/api/v1/assets/${encodeURIComponent(assetId)}/content`,
    headers: { authorization: `Bearer ${session.sessionToken}` },
  };
}

/** 素材操作错误转用户可读文案（保持本地、不泄露内部信息） */
export function assetErrorCopy(code: string): string {
  const copy: Record<string, string> = {
    asset_upload_failed: "素材上传失败，请重试",
    asset_not_found: "素材不存在或已被删除",
    asset_name_required: "请输入素材名称",
    asset_content_missing: "素材文件缺失",
    invalid_request: "请求参数不合法",
    upload_too_large: "文件超出大小限制",
    authentication_required: "登录已失效，请重新登录",
  };
  return copy[code] ?? "操作失败，请稍后重试";
}

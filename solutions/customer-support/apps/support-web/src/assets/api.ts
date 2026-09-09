/**
 * 素材空间 API 客户端（平台级 /api/v1/assets）。
 * 上传入空间、分页浏览（category + 搜索 + keyset 游标）、重命名、软删除。
 */
import { api } from "@/api";

export type AssetItem = {
  assetId: string;
  category: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

export type AssetCategory = "image" | "file";

export type AssetListParams = {
  category?: AssetCategory;
  search?: string;
  limit?: number;
  cursor?: string;
};

export async function listAssets(
  params: AssetListParams,
): Promise<{ items: AssetItem[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (params.category) qs.set("category", params.category);
  if (params.search) qs.set("search", params.search);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return api(`/api/v1/assets${query ? `?${query}` : ""}`);
}

export async function uploadAsset(file: File): Promise<AssetItem> {
  const fd = new FormData();
  fd.append("file", file);
  const result = await api<{ asset: AssetItem }>("/api/v1/assets", {
    method: "POST",
    body: fd,
  });
  return result.asset;
}

export async function renameAsset(assetId: string, name: string): Promise<AssetItem> {
  const result = await api<{ asset: AssetItem }>(
    `/api/v1/assets/${encodeURIComponent(assetId)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  return result.asset;
}

export async function deleteAsset(assetId: string): Promise<void> {
  await api(`/api/v1/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
}

/** 带认证的素材内容地址（img/fetch 均同源携带 cookie） */
export function assetContentUrl(assetId: string): string {
  return `/api/v1/assets/${encodeURIComponent(assetId)}/content`;
}

export function formatAssetSize(size: number): string {
  if (size >= 1_048_576) return `${(size / 1_048_576).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${size} B`;
}

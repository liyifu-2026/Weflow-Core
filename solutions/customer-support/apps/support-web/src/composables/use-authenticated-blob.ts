/**
 * 认证媒体拉取（Authenticated Blob Lifecycle）。
 *
 * 统一「cookie 凭证 fetch → Blob → object URL → 卸载/换源时 revoke」的
 * 生命周期与 loading/ready/failed 状态，供头像/图片/语音/文件等组件共用；
 * 组件只保留各自的降级 UI 与特殊流（如全屏原图、audio/silk 门控、
 * 下载进度——那些用导出的 fetchAuthenticatedBlob 助手自行组装）。
 *
 * 模块级 blob 缓存：同一 URL 只下载一次。认证媒体按 URL 唯一（mediaId 在
 * 路径里），会话切换/组件重挂时直接命中缓存，不再重复下载（此前每次重挂
 * 都重新拉全量字节，是图片"看着慢"的主因之一）。上限 100 条先进先出。
 */
import { onMounted, onUnmounted, ref, type Ref } from "vue";

export type BlobStatus = "loading" | "ready" | "failed";

/** 带凭证拉取一个 Blob（组件特殊流的公共底座） */
export async function fetchAuthenticatedBlob(
  url: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new Error(`fetch ${response.status}`);
  return response.blob();
}

const BLOB_CACHE_LIMIT = 100;
const blobCache = new Map<string, Promise<Blob>>();

/** 缓存版拉取：命中即复用；失败不入缓存，允许下次重试 */
export function cachedAuthenticatedBlob(url: string): Promise<Blob> {
  const hit = blobCache.get(url);
  if (hit) return hit;
  const pending = fetchAuthenticatedBlob(url).catch((error: unknown) => {
    blobCache.delete(url);
    throw error;
  });
  if (blobCache.size >= BLOB_CACHE_LIMIT) {
    const oldest = blobCache.keys().next().value;
    if (oldest !== undefined) blobCache.delete(oldest);
  }
  blobCache.set(url, pending);
  return pending;
}

export type UseAuthenticatedBlob = ReturnType<typeof useAuthenticatedBlob>;

export function useAuthenticatedBlob(options: {
  /** 返回要拉取的 URL；null/空 = 直接 failed（如缺 contactId），不发起请求 */
  url: () => string | null | undefined;
  /**
   * 拿到响应后的门控：返回 true 表示组件已自行处置该响应（如语音的
   * audio/silk 分支），composable 不再 blob 化，status 保持 loading 由
   * 组件自行改写。设置后该实例不走共享缓存（需要原始 Response）。
   */
  onResponse?: (response: Response) => boolean;
  /** 拿到 Blob 后回调（组件做特殊装配，如语音的 Audio 元素），不影响生命周期 */
  onBlob?: (blob: Blob) => void;
}) {
  const { url, onResponse, onBlob } = options;

  const status = ref<BlobStatus>("loading");
  const objectUrl = ref("");
  let blobUrl: string | null = null;
  let disposed = false;
  let generation = 0;

  function revokeCurrent() {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }

  async function load(): Promise<void> {
    const target = url();
    if (!target) {
      status.value = "failed";
      return;
    }
    const requestId = ++generation;
    status.value = "loading";
    try {
      let blob: Blob;
      if (onResponse) {
        // 组件自行处置响应（语音 silk 门控）时不走共享缓存
        const response = await fetch(target, { credentials: "include" });
        if (onResponse(response)) return;
        if (!response.ok) throw new Error(`fetch ${response.status}`);
        blob = await response.blob();
      } else {
        blob = await cachedAuthenticatedBlob(target);
      }
      // 卸载或已被更新的请求取代：不建 object URL（否则泄漏）
      if (disposed || requestId !== generation) return;
      revokeCurrent();
      blobUrl = URL.createObjectURL(blob);
      objectUrl.value = blobUrl;
      onBlob?.(blob);
      status.value = "ready";
    } catch {
      if (disposed || requestId !== generation) return;
      status.value = "failed";
    }
  }

  onMounted(() => {
    void load();
  });
  onUnmounted(() => {
    disposed = true;
    revokeCurrent();
  });

  return {
    status: status as Ref<BlobStatus>,
    objectUrl: objectUrl as Ref<string>,
    load,
  };
}

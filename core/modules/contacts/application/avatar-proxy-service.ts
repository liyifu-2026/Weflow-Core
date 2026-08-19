/**
 * 联系人头像代理服务
 *
 * 前端不直接访问通道侧的头像 CDN，统一经过本服务：从 contactProfiles 读出
 * 的头像 URL 先做域名白名单校验（防 SSRF），再带超时拉取并做进程内
 * TTL 缓存，避免每个头像位每次都打上游 CDN。
 *
 * 白名单由部署方通过 AVATAR_ALLOWED_HOSTS 配置（逗号分隔的后缀列表）；
 * 未配置时头像代理一律 404（不拉取任何外部 URL）。
 */

export type AvatarFetchResult =
  | { state: "ready"; body: ArrayBuffer; mimeType: string }
  | { state: "not_found" }
  | { state: "failed" };

type CacheEntry = {
  url: string;
  body: ArrayBuffer;
  mimeType: string;
  expiresAt: number;
};

type AvatarProxyServiceOptions = {
  /** 允许拉取的头像域名后缀白名单（后缀匹配子域名）；空 = 全部拒绝 */
  allowedHosts?: string[];
  /** 上游拉取超时（毫秒） */
  timeoutMs?: number;
  /** 缓存 TTL（毫秒） */
  cacheTtlMs?: number;
  /** 缓存条目上限，超出时按最旧淘汰 */
  maxEntries?: number;
  /** 可注入的 fetch（测试用） */
  fetch?: typeof globalThis.fetch;
};

/** 校验头像 URL 是否属于允许的域名白名单（后缀匹配子域名） */
export function isAllowedAvatarUrl(
  url: string,
  allowedHosts: readonly string[],
): boolean {
  if (allowedHosts.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
}

export class AvatarProxyService {
  readonly #allowedHosts: readonly string[];
  readonly #timeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #maxEntries: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: AvatarProxyServiceOptions = {}) {
    this.#allowedHosts = options.allowedHosts ?? [];
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#cacheTtlMs = options.cacheTtlMs ?? 3_600_000;
    this.#maxEntries = options.maxEntries ?? 512;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** 校验头像 URL 是否属于配置的白名单（后缀匹配子域名） */
  isAllowedAvatarUrl(url: string): boolean {
    return isAllowedAvatarUrl(url, this.#allowedHosts);
  }

  /** 拉取（或命中缓存）一张头像；调用前必须已通过 isAllowedAvatarUrl 校验 */
  async fetch(url: string): Promise<AvatarFetchResult> {
    const cached = this.#cache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      // 命中缓存会刷新过期时间（LRU 语义），并保持在 Map 末尾
      this.#cache.delete(url);
      this.#cache.set(url, cached);
      return { state: "ready", body: cached.body, mimeType: cached.mimeType };
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      this.#cache.delete(url);
      return { state: "failed" };
    }
    if (response.status === 404) {
      this.#cache.delete(url);
      return { state: "not_found" };
    }
    if (!response.ok) {
      this.#cache.delete(url);
      return { state: "failed" };
    }
    const mimeType =
      response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    const body = await response.arrayBuffer().catch(() => undefined);
    if (!body) return { state: "failed" };

    // 写入缓存：容量满时淘汰最旧条目
    if (this.#cache.size >= this.#maxEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(url, {
      url,
      body,
      mimeType,
      expiresAt: Date.now() + this.#cacheTtlMs,
    });
    return { state: "ready", body, mimeType };
  }
}

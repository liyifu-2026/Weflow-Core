/**
 * DiceBear 头像生成代理（平台中立头像能力）。
 *
 * 头像外观由 DiceBear 确定性生成（同 style+seed 永远同一图形，CC0 1.0），
 * Core 只保存「样式 + 种子」并代理取图：服务端拉取 SVG 并做进程内缓存，
 * 前端（Console / Solution 端 / Mobile）统一经本代理 URL 渲染，
 * 不直连第三方域名（不泄漏用户数据、不受客户端网络环境差异影响）。
 *
 * 失败语义：上游不可达/超时返回 null，由路由层回退 502，
 * 前端按既有逻辑降级为首字母占位。
 */

export const DICEBEAR_STYLES = ["blobs", "voxel-bot"] as const;

export type DiceBearStyle = (typeof DICEBEAR_STYLES)[number];

const DICEBEAR_BASE_URL = "https://api.dicebear.com/10.x";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_MAX_ENTRIES = 500;

export function isDiceBearStyle(value: string): value is DiceBearStyle {
  return (DICEBEAR_STYLES as readonly string[]).includes(value);
}

/** 平台代理 URL（相对路径，两端拼自己的 base）；seed 任意字符串，URL 安全 */
export function diceBearAvatarUrl(style: DiceBearStyle, seed: string): string {
  return `/api/v1/avatars/dicebear/${style}/${encodeURIComponent(seed)}`;
}

type CacheEntry = { svg: string; fetchedAt: number };

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const svgCache = new Map<string, CacheEntry>();

function cacheKey(style: DiceBearStyle, seed: string): string {
  return `${style}:${seed}`;
}

/** LRU 语义的简单实现：命中时重新插入保持新鲜度，超容量时淘汰最旧项 */
function cacheGet(key: string): CacheEntry | undefined {
  const hit = svgCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.fetchedAt > CACHE_TTL_MS) {
    svgCache.delete(key);
    return undefined;
  }
  svgCache.delete(key);
  svgCache.set(key, hit);
  return hit;
}

function cachePut(key: string, svg: string): void {
  if (svgCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
  svgCache.set(key, { svg, fetchedAt: Date.now() });
}

/**
 * 取 DiceBear 生成的 SVG 文本；命中缓存不发网络请求。
 * 失败（网络/超时/非 2xx/空 body）返回 null。
 */
export async function fetchDiceBearSvg(
  style: DiceBearStyle,
  seed: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const key = cacheKey(style, seed);
  const cached = cacheGet(key);
  if (cached) return cached.svg;
  try {
    const url = `${DICEBEAR_BASE_URL}/${style}/svg?seed=${encodeURIComponent(seed)}`;
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const svg = (await response.text()).trim();
    if (!svg.startsWith("<svg") && !svg.startsWith("<?xml")) return null;
    cachePut(key, svg);
    return svg;
  } catch {
    return null;
  }
}

/** 测试辅助：清空进程内缓存 */
export function clearDiceBearCache(): void {
  svgCache.clear();
}

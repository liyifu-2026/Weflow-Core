const SAFE_PATHS = [
  /^knowledge-bases(?:\/.*)?$/,
  /^knowledge(?:\/.*)?$/,
  /^chunks(?:\/.*)?$/,
  /^knowledgebase\/[A-Za-z0-9_-]+\/wiki(?:\/.*)?$/,
  /^datasource(?:\/.*)?$/,
  /^chunker\/preview$/,
  /^models(?:\/.*)?$/,
  /^vector-stores(?:\/.*)?$/,
  /^storage-backends(?:\/.*)?$/,
  /^faq\/import\/progress\/[A-Za-z0-9_-]+$/,
  /^knowledge-search$/,
];
const SAFE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
export const MAX_KNOWLEDGE_UPLOAD_BYTES = 25 * 1024 * 1024;

export type KnowledgeProviderOptions = {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
};

export function providerPath(request: {
  raw: { url?: string | undefined };
}): string | undefined {
  const prefix = "/api/v1/console/knowledge-provider/";
  const raw = request.raw.url?.split("?", 1)[0];
  if (!raw?.startsWith(prefix)) return undefined;
  const encoded = raw.slice(prefix.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  if (
    !decoded ||
    decoded.includes("..") ||
    decoded.includes("\\") ||
    decoded.startsWith("/") ||
    decoded.includes("//") ||
    /%(?:2e|2f|5c)/i.test(decoded)
  )
    return undefined;
  return decoded;
}

export function isAllowedKnowledgeProviderPath(path: string): boolean {
  return SAFE_PATHS.some((pattern) => pattern.test(path));
}

export function isAllowedKnowledgeProviderMethod(
  path: string,
  method: string,
): boolean {
  if (!SAFE_METHODS.has(method)) return false;
  if (path === "knowledge-search" || path === "chunker/preview") {
    return method === "POST";
  }
  return true;
}

export function knowledgeProviderAccess(
  path: string,
  method: string,
): "read" | "write" {
  return method === "GET" ||
    method === "HEAD" ||
    (method === "POST" && path === "knowledge-search")
    ? "read"
    : "write";
}

export async function inspectKnowledgeEngine(
  options: KnowledgeProviderOptions | undefined,
): Promise<{
  checkedAt: string;
  status: "ready" | "degraded" | "not_configured";
  components: Array<{
    key: string;
    name: string;
    status: "ready" | "unavailable" | "not_configured";
    summary: string;
  }>;
}> {
  const checkedAt = new Date().toISOString();
  if (!options) {
    return {
      checkedAt,
      status: "not_configured",
      components: [
        {
          key: "provider",
          name: "知识服务连接",
          status: "not_configured",
          summary: "尚未配置知识服务凭据",
        },
        {
          key: "gateway",
          name: "Weflow 安全代理",
          status: "ready",
          summary: "路径白名单与角色校验已启用",
        },
      ],
    };
  }

  let reachable = false;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      `${options.baseUrl}/knowledge-bases?page=1&page_size=1`,
      {
        method: "GET",
        headers: { "x-api-key": options.apiKey },
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    reachable = response.ok;
    await response.body?.cancel();
  } catch {
    // Keep the redacted unavailable state; upstream details are intentionally discarded.
  }

  return {
    checkedAt,
    status: reachable ? "ready" : "degraded",
    components: [
      {
        key: "provider",
        name: "知识服务连接",
        status: reachable ? "ready" : "unavailable",
        summary: reachable ? "服务可访问" : "服务当前不可访问",
      },
      {
        key: "gateway",
        name: "Weflow 安全代理",
        status: "ready",
        summary: "路径白名单、25 MB 上传限制与操作审计已启用",
      },
    ],
  };
}

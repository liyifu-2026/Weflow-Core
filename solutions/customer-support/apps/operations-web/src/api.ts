/**
 * Operations Console — API client.
 *
 * Embedded mode (Console ExtensionHost): every request is delegated to the
 * restricted bridge handed over by the host — the bundle never touches the
 * Console's internal stores or router.
 *
 * Standalone/dev mode: falls back to direct same-origin fetch so
 * `pnpm dev` works against a locally running Core via the Vite proxy.
 */
export type ApiError = Error & { status?: number; code?: string };

type BridgeFetch = (path: string, init?: RequestInit) => Promise<Response>;

let bridgeFetch: BridgeFetch | null = null;

export function setApiBridge(implementation: BridgeFetch | null): void {
  bridgeFetch = implementation;
}

export type { BridgeFetch };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  const send = bridgeFetch ?? ((p, i) => fetch(p, i));
  const response = await send(path, {
    ...init,
    headers,
    credentials: "include",
  });
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const code =
      typeof payload === "object" && payload
        ? String((payload as { error?: string }).error ?? "")
        : "";
    const error = new Error(errorCopy(code, response.status)) as ApiError;
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return payload as T;
}

function errorCopy(code: string, status: number): string {
  const copy: Record<string, string> = {
    authentication_required: "登录已失效，请重新登录",
    admin_required: "此操作仅管理员可执行",
    invalid_request: "请求参数不合法，请检查填写内容",
  };
  return (
    copy[code] ??
    (status >= 500 ? "服务暂时不可用，请稍后再试" : "请求未被接受")
  );
}

/**
 * HTTP API 客户端模块
 * 封装与 Core 的所有 HTTP 通信，统一处理请求头、认证令牌和错误响应。
 * 支持自动触发认证失效事件（401 响应时）。
 */
import { apiBaseUrl } from "./config";
import { notifyAuthenticationRequired } from "../auth/auth-events";

export { notifyAuthenticationRequired };

/** API 错误类，包含服务端返回的错误码和 HTTP 状态码 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

/**
 * 发送 HTTP 请求到 Core
 * @param path - API 路径（不含基础地址）
 * @param options - 请求选项，可选传入 token 用于认证
 * @returns 解析后的 JSON 响应体
 * @throws ApiError 当响应状态码非 2xx 时抛出
 */
export async function request<T>(
  path: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, headers, ...init } = options;
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    // 仅在携带 token 的请求收到 401 时触发认证失效事件，避免登录接口本身 401 导致死循环
    if (response.status === 401 && token) notifyAuthenticationRequired();
    throw new ApiError(payload.error ?? "request_failed", response.status);
  }
  // 204 No Content 无需解析 JSON
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

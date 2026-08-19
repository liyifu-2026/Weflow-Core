/**
 * WeKnora 认证与成员管理的 HTTP 客户端（桥接专用）。
 * 注册/登录走公开接口；成员管理复用 weflow 已有的租户 API Key（full_access）。
 */
import { randomBytes } from "node:crypto";

export type KnoraUpstream = {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
};

/** 认证失败（凭据错误 / 冲突）与其他错误的区分由调用方按 HTTP 状态处理 */
export class KnoraHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = "KnoraHttpError";
  }
}

type KnoraAuth = { bearer: string } | { apiKey: boolean };

async function knoraFetch(
  upstream: KnoraUpstream,
  path: string,
  init: { method: string; body?: unknown; auth?: KnoraAuth },
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": `server2-knora-bridge-${randomBytes(14).toString("hex")}`,
  };
  if (init.auth) {
    if ("bearer" in init.auth) {
      headers.authorization = `Bearer ${init.auth.bearer}`;
    } else {
      headers["x-api-key"] = upstream.apiKey;
    }
  }
  try {
    const response = await fetch(`${upstream.baseUrl}${path}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? ((body as { error?: { message?: string } }).error?.message ?? "")
          : `knora ${path} -> HTTP ${String(response.status)}`;
      const code =
        typeof body === "object" && body !== null && "error" in body
          ? (body as { error?: { code?: number } }).error?.code
          : undefined;
      throw new KnoraHttpError(response.status, message || "knora error", code);
    }
    return { status: response.status, body };
  } catch (reason) {
    if (reason instanceof KnoraHttpError) throw reason;
    throw new KnoraHttpError(
      0,
      reason instanceof Error ? reason.message : "knora unreachable",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function knoraRegister(
  upstream: KnoraUpstream,
  input: { username: string; email: string; password: string },
): Promise<{ userId: string }> {
  const { body } = await knoraFetch(
    upstream,
    "/auth/register",
    { method: "POST", body: input },
    upstream.timeoutMs,
  );
  const user =
    typeof body === "object" && body !== null && "user" in body
      ? (body as { user?: { id?: string } }).user
      : undefined;
  return { userId: user?.id ?? "" };
}

export type KnoraLoginResponse = {
  token: string;
  refresh_token: string;
  user: unknown;
  active_tenant: unknown;
  memberships: unknown[];
};

export async function knoraLogin(
  upstream: KnoraUpstream,
  input: { email: string; password: string },
): Promise<KnoraLoginResponse> {
  const { body } = await knoraFetch(
    upstream,
    "/auth/login",
    { method: "POST", body: input },
    upstream.timeoutMs,
  );
  return body as KnoraLoginResponse;
}

export async function knoraAddMember(
  upstream: KnoraUpstream,
  input: { tenantId: number; email: string; role: string },
): Promise<void> {
  await knoraFetch(
    upstream,
    `/tenants/${String(input.tenantId)}/members`,
    {
      method: "POST",
      body: { email: input.email, role: input.role },
      auth: { apiKey: true },
    },
    upstream.timeoutMs,
  );
}

/** 以用户身份读取激活租户信息（成员可见；返回 TenantResponse 形状） */
export async function knoraGetTenant(
  upstream: KnoraUpstream,
  input: { tenantId: number; bearer: string },
): Promise<unknown> {
  const { body } = await knoraFetch(
    upstream,
    `/tenants/${String(input.tenantId)}`,
    { method: "GET", auth: { bearer: input.bearer } },
    upstream.timeoutMs,
  );
  return body;
}

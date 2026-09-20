/**
 * 请求认证中间件
 * 从 HTTP 请求中提取 Bearer Token 或 Cookie 会话标识，
 * 验证用户身份并提供强制认证守卫。
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { BusinessDb } from "../../identity/application/db.js";
import {
  authenticate,
  type AuthenticatedUser,
} from "../application/identity-service.js";

const COOKIE_NAME = "weflow_session";

/**
 * Cookie 安全旗标的唯一事实源：main.ts 启动时从已校验 config 注入。
 * 未注入时（测试环境）回落 env/NODE_ENV 判定，行为与注入语义一致——
 * 此前模块直读 process.env 与 config 形成两个事实源，已收敛。
 */
let cookieDomainOverride: string | undefined;
let cookieSecureOverride: boolean | undefined;

/** 启动时注入已校验的 Cookie 安全配置（main.ts 调用，进程级一次） */
export function configureSessionCookies(input: {
  domain?: string | undefined;
  secure: boolean;
}): void {
  cookieDomainOverride = input.domain;
  cookieSecureOverride = input.secure;
}

/** 请求中解析出的用户身份信息 */
export type RequestIdentity = {
  token: string;
  user: AuthenticatedUser;
};

/** 从请求头或 Cookie 中提取并验证用户身份，未认证时返回 undefined */
export async function requestIdentity(
  db: BusinessDb,
  request: FastifyRequest,
): Promise<RequestIdentity | undefined> {
  const token =
    bearerToken(request.headers.authorization) ??
    cookieValue(request.headers.cookie, COOKIE_NAME);
  if (!token) return undefined;
  const user = await authenticate(db, token);
  return user ? { token, user } : undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{20,})$/i.exec(header.trim());
  return match?.[1];
}

/**
 * 强制要求业务身份认证。
 * 未认证返回 401，需要修改密码时返回 403。
 */
export async function requireBusinessIdentity(
  db: BusinessDb,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<RequestIdentity | undefined> {
  const identity = await requestIdentity(db, request);
  if (!identity) {
    await reply.code(401).send({ error: "authentication_required" });
    return undefined;
  }
  if (identity.user.mustChangePassword) {
    await reply.code(403).send({ error: "password_change_required" });
    return undefined;
  }
  return identity;
}

/** 强制要求管理员身份。业务身份通过后再做角色判断，默认拒绝。 */
export async function requireAdminIdentity(
  db: BusinessDb,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<RequestIdentity | undefined> {
  const identity = await requireBusinessIdentity(db, request, reply);
  if (!identity) return undefined;
  if (identity.user.role !== "admin") {
    await reply.code(403).send({ error: "admin_required" });
    return undefined;
  }
  return identity;
}

/**
 * 会话 Cookie 是否带 Secure：production 默认 true（HTTPS only），
 * 可用 SESSION_COOKIE_SECURE 显式覆盖（局域网 HTTP 部署必须为 false，
 * 否则浏览器不回传 Cookie 导致无法登录）。与 config schema 的枚举对齐。
 */
function cookieSecure(): boolean {
  if (cookieSecureOverride !== undefined) return cookieSecureOverride;
  const override = process.env.SESSION_COOKIE_SECURE?.trim();
  if (override === "true") return true;
  if (override === "false") return false;
  return process.env.NODE_ENV === "production";
}

/**
 * 生成会话 Cookie 字符串。
 * 本地开发通常通过 HTTP（包括局域网 IP）访问；生产环境默认使用 Secure。
 */
export function sessionCookie(token: string, expiresAt: Date): string {
  const secure = cookieSecure();
  const domain = cookieDomainOverride ? ` Domain=${cookieDomainOverride};` : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly;${domain}${secure ? " Secure;" : ""} SameSite=Strict; Expires=${expiresAt.toUTCString()}`;
}

/** 生成清除会话 Cookie 的 Set-Cookie 头值 */
export function clearSessionCookie(): string {
  const secure = cookieSecure();
  const domain = cookieDomainOverride ? ` Domain=${cookieDomainOverride};` : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${domain}${secure ? " Secure;" : ""} SameSite=Strict; Max-Age=0`;
}

function cookieValue(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

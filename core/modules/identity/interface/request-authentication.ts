/**
 * 请求认证中间件
 * 从 HTTP 请求中提取 Bearer Token 或 Cookie 会话标识，
 * 验证用户身份并提供强制认证守卫。
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import {
  authenticate,
  type AuthenticatedUser,
} from "../application/identity-service.js";

const COOKIE_NAME = "weflow_session";
const COOKIE_DOMAIN = process.env.SESSION_COOKIE_DOMAIN?.trim();

/** 请求中解析出的用户身份信息 */
export type RequestIdentity = {
  token: string;
  user: AuthenticatedUser;
};

/** 从请求头或 Cookie 中提取并验证用户身份，未认证时返回 undefined */
export async function requestIdentity(
  db: NodePgDatabase<typeof schema>,
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
  db: NodePgDatabase<typeof schema>,
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
  db: NodePgDatabase<typeof schema>,
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
 * Runner 机器身份。
 * Runner 只能通过 RUNNER_TOKEN 访问专用 runner 端点，不能访问 Console 管理接口。
 */
export async function requireRunnerIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ runnerId: string } | undefined> {
  const expected = process.env.RUNNER_TOKEN;
  const token = bearerToken(request.headers.authorization);
  if (!expected || !token || token !== expected) {
    await reply.code(401).send({ error: "runner_authentication_required" });
    return undefined;
  }
  return { runnerId: process.env.RUNNER_ID ?? "runner" };
}

/**
 * 生成会话 Cookie 字符串。
 * 本地开发通常通过 HTTP（包括局域网 IP）访问 Console；生产环境仍始终使用 Secure。
 */
export function sessionCookie(token: string, expiresAt: Date): string {
  const secure = process.env.NODE_ENV === "production";
  const domain = COOKIE_DOMAIN ? ` Domain=${COOKIE_DOMAIN};` : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly;${domain}${secure ? " Secure;" : ""} SameSite=Strict; Expires=${expiresAt.toUTCString()}`;
}

/** 生成清除会话 Cookie 的 Set-Cookie 头值 */
export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production";
  const domain = COOKIE_DOMAIN ? ` Domain=${COOKIE_DOMAIN};` : "";
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

/**
 * 身份认证服务模块
 * 提供用户创建、登录、会话认证、密码修改和登出等核心功能。
 * 会话令牌以 SHA-256 摘要形式存储，支持审计日志记录。
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  hashPassword,
  verifyPassword,
} from "../../../infrastructure/auth/password.js";
import * as schema from "../../../infrastructure/postgres/schema.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

/** 信息名片标签上限（与专家队列词表规模一致） */
export const MAX_AGENT_TAGS = 7;
/** 通用兜底队列（seed 数据），不作为可选标签出现在词表中 */
const GENERAL_HANDOFF_QUEUE_ID = "queue-general";

/** 已认证用户信息 */
export type AuthenticatedUser = {
  userId: string;
  username: string;
  role: "admin" | "operator";
  mustChangePassword: boolean;
  /** 客服头像相对路径（无头像为 null），如 /api/v1/users/:userId/avatar */
  avatarUrl: string | null;
  /** 信息名片显示名（可空；空 = 展示 username） */
  displayName: string | null;
  /** 客服自选专家标签（标签键 = 专家队列 key，用于转人工定向路由） */
  tags: string[];
};

/** 头像相对路径（avatar_file_id 存在时） */
function avatarUrlOf(user: {
  userId: string;
  avatarFileId: string | null;
}): string | null {
  return user.avatarFileId ? `/api/v1/users/${user.userId}/avatar` : null;
}

/** 将用户行投影为对外认证用户（不含密码哈希等内部字段） */
function projectAuthenticatedUser(user: {
  userId: string;
  username: string;
  role: string;
  mustChangePassword: boolean;
  avatarFileId: string | null;
  displayName: string | null;
  tags: string[];
}): AuthenticatedUser {
  return {
    userId: user.userId,
    username: user.username,
    role: user.role as "admin" | "operator",
    mustChangePassword: user.mustChangePassword,
    avatarUrl: avatarUrlOf(user),
    displayName: user.displayName,
    tags: user.tags,
  };
}

/** 名片资料更新结果 */
export type UpdateProfileResult =
  | { status: "ok"; user: AuthenticatedUser }
  | { status: "user_not_found" }
  | { status: "invalid_display_name" }
  | { status: "unknown_tag"; tag: string };

/** 可选的信息名片标签词表（激活状态的专家队列，排除通用兜底队列） */
export async function listTagVocabulary(
  db: NodePgDatabase<typeof schema>,
): Promise<{ key: string; displayName: string }[]> {
  return db
    .select({
      key: schema.specialistQueues.key,
      displayName: schema.specialistQueues.displayName,
    })
    .from(schema.specialistQueues)
    .where(
      and(
        eq(schema.specialistQueues.isActive, true),
        ne(schema.specialistQueues.queueId, GENERAL_HANDOFF_QUEUE_ID),
      ),
    )
    .orderBy(asc(schema.specialistQueues.key));
}

/**
 * 更新信息名片资料（显示名 / 专家标签）。
 * 标签与专家队列同源（标签键 = 队列 key），保证转人工时可按标签定向路由。
 */
export async function updateProfile(
  db: NodePgDatabase<typeof schema>,
  userId: string,
  input: {
    displayName?: string | null | undefined;
    tags?: string[] | undefined;
  },
  sourceIp: string,
): Promise<UpdateProfileResult> {
  const vocabulary = await listTagVocabulary(db);
  const validKeys = new Set(vocabulary.map((row) => row.key));

  let displayName: string | null | undefined;
  if (input.displayName !== undefined) {
    if (input.displayName === null) {
      displayName = null;
    } else {
      const trimmed = input.displayName.trim();
      if (trimmed.length < 1 || trimmed.length > 24) {
        return { status: "invalid_display_name" };
      }
      displayName = trimmed;
    }
  }

  let tags: string[] | undefined;
  if (input.tags !== undefined) {
    const unique = [...new Set(input.tags)];
    if (unique.length > MAX_AGENT_TAGS) {
      // 超出上限按未知标签处理（词表本身不超过 7 项）
      return { status: "unknown_tag", tag: unique[MAX_AGENT_TAGS] ?? "" };
    }
    for (const tag of unique) {
      if (!validKeys.has(tag)) return { status: "unknown_tag", tag };
    }
    tags = unique;
  }

  const updated = await db.transaction(async (transaction) => {
    const rows = await transaction
      .update(schema.users)
      .set({
        ...(displayName !== undefined ? { displayName } : {}),
        ...(tags !== undefined ? { tags } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.users.userId, userId))
      .returning();
    const user = rows[0];
    if (!user) return undefined;
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: userId,
      eventType: "identity.profile_updated",
      subjectType: "user",
      subjectId: userId,
      sourceIp,
      // 审计 metadata 列为字符串值；标签以逗号连接（key 为 snake_case，无歧义）
      metadata: {
        ...(displayName !== undefined
          ? { displayName: displayName ?? "" }
          : {}),
        ...(tags !== undefined ? { tags: tags.join(",") } : {}),
      },
    });
    return user;
  });
  if (!updated) return { status: "user_not_found" };
  return { status: "ok", user: projectAuthenticatedUser(updated) };
}

/** 登录成功返回结果 */
export type LoginResult = {
  token: string;
  expiresAt: Date;
  user: AuthenticatedUser;
};

/** 创建封闭用户（需在首次登录后修改密码） */
export async function createClosedUser(
  db: NodePgDatabase<typeof schema>,
  usernameInput: string,
  initialPassword: string,
  role: "admin" | "operator" = "operator",
  actor?: { userId: string; sourceIp: string },
): Promise<AuthenticatedUser> {
  const username = normalizeUsername(usernameInput);
  validatePassword(initialPassword);
  const userId = randomUUID();
  const passwordHash = await hashPassword(initialPassword);
  await db.transaction(async (transaction) => {
    await transaction.insert(schema.users).values({
      userId,
      username,
      passwordHash,
      role,
      mustChangePassword: true,
      status: "active",
    });
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: actor?.userId ?? null,
      eventType: "identity.user_created",
      subjectType: "user",
      subjectId: userId,
      sourceIp: actor?.sourceIp ?? null,
      metadata: {
        username,
        role,
        creationMethod: actor ? "console_admin" : "closed_cli",
      },
    });
  });
  return projectAuthenticatedUser({
    userId,
    username,
    role,
    mustChangePassword: true,
    avatarFileId: null,
    displayName: null,
    tags: [],
  });
}

/**
 * 用户登录。
 * 验证用户名和密码，成功时创建会话并返回令牌。
 * 登录失败会执行哈希操作以防止时序攻击。
 */
export async function login(
  db: NodePgDatabase<typeof schema>,
  usernameInput: string,
  password: string,
  sourceIp: string,
): Promise<LoginResult | undefined> {
  const username = normalizeUsername(usernameInput);
  const rows = await db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.username, username),
        eq(schema.users.status, "active"),
      ),
    )
    .limit(1);
  const user = rows[0];
  if (!user) {
    await hashPassword(password);
    await recordFailedLogin(db, username, sourceIp);
    return undefined;
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    await recordFailedLogin(db, username, sourceIp);
    return undefined;
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.transaction(async (transaction) => {
    await transaction.insert(schema.userSessions).values({
      sessionId: randomUUID(),
      userId: user.userId,
      tokenDigest: tokenDigest(token),
      expiresAt,
    });
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: user.userId,
      eventType: "identity.login_succeeded",
      subjectType: "session",
      subjectId: user.userId,
      sourceIp,
      metadata: {},
    });
  });
  return {
    token,
    expiresAt,
    user: projectAuthenticatedUser(user),
  };
}

/** 通过会话令牌认证用户，验证令牌有效性和会话未过期 */
export async function authenticate(
  db: NodePgDatabase<typeof schema>,
  token: string,
): Promise<AuthenticatedUser | undefined> {
  const rows = await db
    .select({
      userId: schema.users.userId,
      username: schema.users.username,
      role: schema.users.role,
      mustChangePassword: schema.users.mustChangePassword,
      avatarFileId: schema.users.avatarFileId,
      displayName: schema.users.displayName,
      tags: schema.users.tags,
    })
    .from(schema.userSessions)
    .innerJoin(
      schema.users,
      eq(schema.users.userId, schema.userSessions.userId),
    )
    .where(
      and(
        eq(schema.userSessions.tokenDigest, tokenDigest(token)),
        isNull(schema.userSessions.revokedAt),
        gt(schema.userSessions.expiresAt, new Date()),
        eq(schema.users.status, "active"),
      ),
    )
    .limit(1);
  const user = rows[0];
  return user ? projectAuthenticatedUser(user) : undefined;
}

/** 修改密码，同时撤销该用户的其他所有会话 */
export async function changePassword(
  db: NodePgDatabase<typeof schema>,
  userId: string,
  currentSessionToken: string,
  currentPassword: string,
  newPassword: string,
  sourceIp: string,
): Promise<boolean> {
  validatePassword(newPassword);
  const rows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.userId, userId))
    .limit(1);
  const user = rows[0];
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
    return false;
  }
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (transaction) => {
    await transaction
      .update(schema.users)
      .set({
        passwordHash,
        mustChangePassword: false,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.userId, userId));
    await transaction
      .update(schema.userSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.userSessions.userId, userId),
          ne(schema.userSessions.tokenDigest, tokenDigest(currentSessionToken)),
          isNull(schema.userSessions.revokedAt),
        ),
      );
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: userId,
      eventType: "identity.password_changed",
      subjectType: "user",
      subjectId: userId,
      sourceIp,
      metadata: {},
    });
  });
  return true;
}

/** 用户登出，撤销当前会话令牌 */
export async function logout(
  db: NodePgDatabase<typeof schema>,
  token: string,
  userId: string,
  sourceIp: string,
): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction
      .update(schema.userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.userSessions.tokenDigest, tokenDigest(token)));
    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: userId,
      eventType: "identity.logout",
      subjectType: "session",
      subjectId: userId,
      sourceIp,
      metadata: {},
    });
  });
}

/** 生成符合复杂度要求的随机初始密码 */
export function generateInitialPassword(): string {
  return `${randomBytes(15).toString("base64url")}!aA1`;
}

/** 计算令牌的 SHA-256 摘要用于数据库存储 */
function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 标准化用户名（转小写、去空格、验证格式） */
function normalizeUsername(input: string): string {
  const username = input.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username)) {
    throw new Error(
      "username must be 3-64 lowercase letters, digits, _, - or .",
    );
  }
  return username;
}

/** 校验密码长度是否符合要求（12-128字符） */
function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 128) {
    throw new Error("password must be between 12 and 128 characters");
  }
}

/** 记录登录失败的审计事件 */
async function recordFailedLogin(
  db: NodePgDatabase<typeof schema>,
  username: string,
  sourceIp: string,
): Promise<void> {
  await db.insert(schema.auditEvents).values({
    auditId: randomUUID(),
    actorUserId: null,
    eventType: "identity.login_failed",
    subjectType: "user_login",
    subjectId: username,
    sourceIp,
    metadata: { username },
  });
}

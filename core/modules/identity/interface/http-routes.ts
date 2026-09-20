/**
 * 身份认证 HTTP 路由
 * 提供登录、登出、密码修改和当前用户查询等 API 端点。
 * 同时支持 Web（Cookie）和移动端（Token）两种认证方式。
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { BusinessDb } from "../application/db.js";
import {
  changePassword,
  listTagVocabulary,
  login,
  logout,
  MAX_AGENT_TAGS,
  setUserAvatarPreset,
  updateProfile,
  type AuthenticatedUser,
} from "../application/identity-service.js";
import {
  LoginThrottle,
  LoginThrottledError,
} from "../application/login-throttle.js";
import {
  USER_AVATAR_PRESETS,
  userAvatarPresetUrl,
} from "../application/avatar-presets.js";
import {
  fetchDiceBearSvg,
  isDiceBearStyle,
} from "../application/dicebear-avatars.js";
import {
  resolveUserAvatar,
  uploadUserAvatar,
  type AvatarFileStore,
} from "../application/avatar-service.js";
import {
  clearSessionCookie,
  requireAdminIdentity,
  requireBusinessIdentity,
  requestIdentity,
  sessionCookie,
} from "./request-authentication.js";
import {
  createManagedUser,
  listManagedUsers,
  resetManagedPassword,
  revokeManagedSessions,
  updateManagedUser,
} from "../application/admin-user-service.js";

const loginBody = z
  .object({
    username: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_.-]+$/i),
    password: z.string().trim().min(1).max(128),
  })
  .strict();
const changePasswordBody = z
  .object({
    // trim：防止"幽灵空格密码"（网页端输入尾随空格原样入库，手机端全新认证失败）
    currentPassword: z.string().trim().min(1).max(128),
    newPassword: z.string().trim().min(12).max(128),
  })
  .strict();
const updateProfileBody = z
  .object({
    // displayName: 名片显示名（1-24 字符；null = 清除，回落为 username）
    displayName: z.string().trim().min(1).max(24).nullable().optional(),
    tags: z
      .array(z.string().trim().min(1).max(80))
      .max(MAX_AGENT_TAGS)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const createUserBody = z
  .object({
    username: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_.-]+$/i),
    role: z.enum(["admin", "operator"]).default("operator"),
  })
  .strict();
const userParams = z.object({ userId: z.uuid() });
const updateUserBody = z
  .object({
    role: z.enum(["admin", "operator"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

/** 注册身份认证相关的 HTTP 路由 */
/** 头像上传约束：仅常见图片格式，最大 1MB */
const AVATAR_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AVATAR_MAX_BYTES = 1_024 * 1_024;
const avatarParams = z.object({
  userId: z.string().min(1).max(36),
});
const avatarPresetBody = z
  .object({
    /** 预设头像 id；null = 清除覆盖，回落到按用户名哈希的默认预设 */
    preset: z.string().trim().min(1).max(40).nullable(),
  })
  .strict();

/** 预设头像统一以 SVG 返回（与上传头像同样的私有、不缓存策略） */
function sendUserAvatarSvg(reply: FastifyReply, svg: string): void {
  reply.header("content-type", "image/svg+xml");
  reply.header("cache-control", "private, no-store");
  reply.header("x-content-type-options", "nosniff");
  reply.send(svg);
}

/** 登录限流器（模块级单例：单进程部署下内存态即全量状态） */
const loginThrottle = new LoginThrottle();

type LoginOutcome =
  | { kind: "sent" }
  | { kind: "ok"; token: string; expiresAt: Date; user: AuthenticatedUser };

/** 登录端点共用：限流检查 + 失败/成功计数 */
async function throttledLogin(
  reply: FastifyReply,
  input: {
    db: BusinessDb;
    ip: string;
    username: string;
    password: string;
    mobile?: boolean;
  },
): Promise<LoginOutcome> {
  try {
    loginThrottle.assertAllowed(input.ip, input.username);
  } catch (error) {
    if (error instanceof LoginThrottledError) {
      reply.header("retry-after", String(error.retryAfterSeconds));
      await reply.code(429).send({ error: "too_many_attempts" });
      return { kind: "sent" };
    }
    throw error;
  }
  const result = await login(
    input.db,
    input.username,
    input.password,
    input.ip,
    input.mobile ? { mobile: true } : {},
  );
  if (!result) {
    loginThrottle.recordFailure(input.ip, input.username);
    await reply.code(401).send({ error: "invalid_credentials" });
    return { kind: "sent" };
  }
  loginThrottle.recordSuccess(input.ip, input.username);
  return {
    kind: "ok",
    token: result.token,
    expiresAt: result.expiresAt,
    user: result.user,
  };
}

export function registerIdentityRoutes(
  server: FastifyInstance,
  db: BusinessDb,
  fileStorage?: AvatarFileStore,
): void {
  server.post("/api/v1/auth/login", async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const outcome = await throttledLogin(reply, {
      db,
      ip: request.ip,
      username: parsed.data.username,
      password: parsed.data.password,
    });
    if (outcome.kind === "sent") return reply;
    reply.header("set-cookie", sessionCookie(outcome.token, outcome.expiresAt));
    return { user: outcome.user };
  });

  server.post("/api/v1/mobile/auth/login", async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const outcome = await throttledLogin(reply, {
      db,
      ip: request.ip,
      username: parsed.data.username,
      password: parsed.data.password,
      mobile: true,
    });
    if (outcome.kind === "sent") return reply;
    return {
      sessionToken: outcome.token,
      expiresAt: outcome.expiresAt.toISOString(),
      user: outcome.user,
    };
  });

  server.get("/api/v1/auth/me", async (request, reply) => {
    const identity = await requestIdentity(db, request);
    if (!identity) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    return { user: identity.user };
  });

  // 信息名片资料更新（显示名 / 专家标签）
  server.put("/api/v1/auth/me", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const body = updateProfileBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = await updateProfile(
      db,
      identity.user.userId,
      body.data,
      request.ip,
    );
    if (result.status === "invalid_display_name") {
      return reply.code(400).send({ error: "invalid_display_name" });
    }
    if (result.status === "unknown_tag") {
      return reply.code(400).send({ error: "unknown_tag", tag: result.tag });
    }
    if (result.status === "user_not_found") {
      return reply.code(404).send({ error: "user_not_found" });
    }
    return { user: result.user };
  });

  // 信息名片可选标签词表（激活状态的专家队列，标签与队列同源）
  server.get("/api/v1/auth/tag-vocabulary", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    return { tags: await listTagVocabulary(db) };
  });

  // 客服头像上传（multipart；fileStorage 未配置时不注册——测试环境兼容）
  if (fileStorage) {
    server.post("/api/v1/auth/avatar", async (request, reply) => {
      const identity = await requireBusinessIdentity(db, request, reply);
      if (!identity) return;
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "invalid_request" });
      if (!AVATAR_MIME_TYPES.has(file.mimetype)) {
        return reply.code(400).send({ error: "avatar_unsupported_type" });
      }
      const buffer = await file.toBuffer();
      if (buffer.length === 0 || buffer.length > AVATAR_MAX_BYTES) {
        return reply.code(413).send({ error: "upload_too_large" });
      }
      const result = await uploadUserAvatar(db, fileStorage, {
        userId: identity.user.userId,
        filename: file.filename,
        mimeType: file.mimetype,
        buffer,
        sourceIp: request.ip,
      });
      return { avatarUrl: result.avatarUrl };
    });
  }

  // 平台预设头像清单（头像选择器渲染；与 DefaultAvatar 默认分配同源）。
  // 预设不再内嵌 SVG：返回平台代理 URL（DiceBear Blobs 确定性生成），
  // 前端经 URL 渲染，与默认分配共用同一条取图链路。
  server.get("/api/v1/users/avatar-presets", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    return {
      presets: USER_AVATAR_PRESETS.map((preset) => ({
        id: preset.id,
        name: preset.name,
        seed: preset.seed,
        svgUrl: userAvatarPresetUrl(preset),
      })),
    };
  });

  // 选择/清除预设头像（当前登录用户自己）
  server.patch("/api/v1/auth/avatar", async (request, reply) => {
    const identity = await requireBusinessIdentity(db, request, reply);
    if (!identity) return;
    const body = avatarPresetBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = await setUserAvatarPreset(
      db,
      identity.user.userId,
      body.data.preset,
      request.ip,
    );
    if (result.status === "invalid_preset") {
      return reply.code(400).send({ error: "avatar_preset_unknown" });
    }
    if (result.status === "user_not_found") {
      return reply.code(404).send({ error: "user_not_found" });
    }
    return { user: result.user };
  });

  // 客服头像读取（内部可见；优先级：自定义上传 > 预设 > 按用户名哈希的默认预设）
  server.get("/api/v1/users/:userId/avatar", async (request, reply) => {
    if (!(await requireBusinessIdentity(db, request, reply))) return;
    const params = avatarParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const content = await resolveUserAvatar(
      db,
      fileStorage,
      params.data.userId,
    );
    if (!content) {
      return reply.code(404).send({ error: "avatar_not_found" });
    }
    if (content.kind === "file") {
      reply.header("content-type", content.mimeType);
      reply.header("cache-control", "private, no-store");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(content.stream);
    }
    sendUserAvatarSvg(reply, content.svg);
  });

  // DiceBear 头像代理（平台中立）：前端统一经此取确定性生成头像，
  // 不直连第三方域名。style 白名单见 DICEBEAR_STYLES（均为 CC0 1.0）。
  server.get(
    "/api/v1/avatars/dicebear/:style/:seed",
    async (request, reply) => {
      if (!(await requireBusinessIdentity(db, request, reply))) return;
      const params = z
        .object({
          style: z.string().min(1).max(40),
          seed: z.string().min(1).max(120),
        })
        .safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      if (!isDiceBearStyle(params.data.style)) {
        return reply.code(404).send({ error: "avatar_style_not_found" });
      }
      const svg = await fetchDiceBearSvg(params.data.style, params.data.seed);
      if (!svg) {
        return reply.code(502).send({ error: "avatar_upstream_unavailable" });
      }
      reply.header("content-type", "image/svg+xml");
      reply.header("cache-control", "private, max-age=86400");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(svg);
    },
  );

  server.post("/api/v1/auth/change-password", async (request, reply) => {
    const identity = await requestIdentity(db, request);
    if (!identity) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    const parsed = changePasswordBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const changed = await changePassword(
      db,
      identity.user.userId,
      identity.token,
      parsed.data.currentPassword,
      parsed.data.newPassword,
      request.ip,
    );
    if (!changed) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    return {
      user: { ...identity.user, mustChangePassword: false },
    };
  });

  server.post("/api/v1/auth/logout", async (request, reply) => {
    const identity = await requestIdentity(db, request);
    if (identity) {
      await logout(db, identity.token, identity.user.userId, request.ip);
    }
    reply.header("set-cookie", clearSessionCookie());
    return reply.code(204).send();
  });

  server.post("/api/v1/mobile/auth/logout", async (request, reply) => {
    const identity = await requestIdentity(db, request);
    if (identity) {
      await logout(db, identity.token, identity.user.userId, request.ip);
    }
    return reply.code(204).send();
  });

  server.get("/api/v1/admin/users", async (request, reply) => {
    if (!(await requireAdminIdentity(db, request, reply))) return;
    return { users: await listManagedUsers(db) };
  });

  server.post("/api/v1/admin/users", async (request, reply) => {
    const identity = await requireAdminIdentity(db, request, reply);
    const body = createUserBody.safeParse(request.body);
    if (!identity || !body.success)
      return reply.code(400).send({ error: "invalid_request" });
    try {
      const result = await createManagedUser(db, {
        ...body.data,
        actorUserId: identity.user.userId,
        sourceIp: request.ip,
      });
      return await reply.code(201).send(result);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505")
        return await reply.code(409).send({ error: "username_exists" });
      throw error instanceof Error ? error : new Error("user_creation_failed");
    }
  });

  server.patch("/api/v1/admin/users/:userId", async (request, reply) => {
    const identity = await requireAdminIdentity(db, request, reply);
    const params = userParams.safeParse(request.params);
    const body = updateUserBody.safeParse(request.body);
    if (!identity || !params.success || !body.success)
      return reply.code(400).send({ error: "invalid_request" });
    const result = await updateManagedUser(db, {
      ...params.data,
      ...(body.data.role ? { role: body.data.role } : {}),
      ...(body.data.status ? { status: body.data.status } : {}),
      actorUserId: identity.user.userId,
      sourceIp: request.ip,
    });
    if (result.status === "not_found")
      return reply.code(404).send({ error: "user_not_found" });
    if (result.status === "last_admin")
      return reply.code(409).send({ error: "last_admin_required" });
    return { user: result.user };
  });

  server.post(
    "/api/v1/admin/users/:userId/reset-password",
    async (request, reply) => {
      const identity = await requireAdminIdentity(db, request, reply);
      const params = userParams.safeParse(request.params);
      if (!identity || !params.success)
        return reply.code(400).send({ error: "invalid_request" });
      const result = await resetManagedPassword(db, {
        ...params.data,
        actorUserId: identity.user.userId,
        sourceIp: request.ip,
      });
      return result
        ? { initialPassword: result.initialPassword }
        : reply.code(404).send({ error: "user_not_found" });
    },
  );

  server.post(
    "/api/v1/admin/users/:userId/revoke-sessions",
    async (request, reply) => {
      const identity = await requireAdminIdentity(db, request, reply);
      const params = userParams.safeParse(request.params);
      if (!identity || !params.success)
        return reply.code(400).send({ error: "invalid_request" });
      return (await revokeManagedSessions(db, {
        ...params.data,
        actorUserId: identity.user.userId,
        sourceIp: request.ip,
      }))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "user_not_found" });
    },
  );
}

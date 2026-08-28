/**
 * 身份认证 HTTP 路由
 * 提供登录、登出、密码修改和当前用户查询等 API 端点。
 * 同时支持 Web（Cookie）和移动端（Token）两种认证方式。
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import * as databaseSchema from "../../../infrastructure/postgres/schema.js";
import type { LocalFileStorage } from "../../../infrastructure/file_storage/local-file-storage.js";
import {
  changePassword,
  listTagVocabulary,
  login,
  logout,
  MAX_AGENT_TAGS,
  setUserAvatarPreset,
  updateProfile,
  userAvatarUrl,
} from "../application/identity-service.js";
import {
  defaultUserAvatarPreset,
  fallbackPresetSvg,
  USER_AVATAR_PRESETS,
  userAvatarPresetById,
  userAvatarPresetUrl,
} from "../application/avatar-presets.js";
import {
  fetchDiceBearSvg,
  isDiceBearStyle,
} from "../application/dicebear-avatars.js";
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

/**
 * 取预设头像 SVG：优先 DiceBear 代理缓存；上游不可达时用本地降级 SVG，
 * 保证头像端点始终有内容（绝不 404/500）。
 */
async function resolvePresetSvg(
  presetId: string,
): Promise<{ svg: string; fromProxy: boolean } | undefined> {
  const preset = userAvatarPresetById(presetId);
  if (!preset) return undefined;
  const proxied = await fetchDiceBearSvg("blobs", preset.seed);
  if (proxied) return { svg: proxied, fromProxy: true };
  return { svg: fallbackPresetSvg(preset), fromProxy: false };
}

export function registerIdentityRoutes(
  server: FastifyInstance,
  db: NodePgDatabase<typeof schema>,
  fileStorage?: LocalFileStorage,
): void {
  server.post("/api/v1/auth/login", async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = await login(
      db,
      parsed.data.username,
      parsed.data.password,
      request.ip,
    );
    if (!result) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    reply.header("set-cookie", sessionCookie(result.token, result.expiresAt));
    return { user: result.user };
  });

  server.post("/api/v1/mobile/auth/login", async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const result = await login(
      db,
      parsed.data.username,
      parsed.data.password,
      request.ip,
    );
    if (!result) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    return {
      sessionToken: result.token,
      expiresAt: result.expiresAt.toISOString(),
      user: result.user,
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
      const stored = await fileStorage.write(
        Readable.from(buffer),
        file.filename,
        file.mimetype,
      );
      let avatarUpdatedAt = new Date();
      try {
        await db.transaction(async (transaction) => {
          await transaction.insert(databaseSchema.storedFiles).values({
            fileId: stored.fileId,
            ownerModule: "identity",
            originalName: stored.originalName,
            mimeType: stored.mimeType,
            size: stored.size,
            checksum: stored.checksum,
            storageKey: stored.storageKey,
            createdByUserId: identity.user.userId,
          });
          const updatedRows = await transaction
            .update(databaseSchema.users)
            .set({
              avatarFileId: stored.fileId,
              // 上传与预设二选一：自定义上传生效时清掉预设引用
              avatarPreset: null,
              updatedAt: new Date(),
            })
            .where(eq(databaseSchema.users.userId, identity.user.userId))
            .returning({ updatedAt: databaseSchema.users.updatedAt });
          const updatedUser = updatedRows[0];
          if (!updatedUser) {
            throw new Error(
              `user ${identity.user.userId} does not exist`,
            );
          }
          avatarUpdatedAt = updatedUser.updatedAt;
          await transaction.insert(databaseSchema.auditEvents).values({
            auditId: randomUUID(),
            actorUserId: identity.user.userId,
            eventType: "identity.avatar_updated",
            subjectType: "user",
            subjectId: identity.user.userId,
            sourceIp: request.ip,
            metadata: { fileId: stored.fileId },
          });
        });
      } catch (reason) {
        await fileStorage.remove(stored.storageKey).catch(() => undefined);
        throw reason;
      }
      return {
        avatarUrl: userAvatarUrl({
          userId: identity.user.userId,
          updatedAt: avatarUpdatedAt,
        }),
      };
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
    const rows = await db
      .select({
        username: databaseSchema.users.username,
        avatarPreset: databaseSchema.users.avatarPreset,
        storageKey: databaseSchema.storedFiles.storageKey,
        mimeType: databaseSchema.storedFiles.mimeType,
      })
      .from(databaseSchema.users)
      .leftJoin(
        databaseSchema.storedFiles,
        eq(
          databaseSchema.storedFiles.fileId,
          databaseSchema.users.avatarFileId,
        ),
      )
      .where(eq(databaseSchema.users.userId, params.data.userId))
      .limit(1);
    const user = rows[0];
    if (!user) {
      return reply.code(404).send({ error: "avatar_not_found" });
    }

    // 1) 自定义上传（文件丢失时继续回落后续来源，不 404）
    if (fileStorage && user.storageKey) {
      if (await fileStorage.exists(user.storageKey)) {
        reply.header("content-type", user.mimeType ?? "image/jpeg");
        reply.header("cache-control", "private, no-store");
        reply.header("x-content-type-options", "nosniff");
        return reply.send(fileStorage.read(user.storageKey));
      }
    }

    // 2) 已选平台预设（未知 id 时回落默认）
    if (user.avatarPreset) {
      const resolved = await resolvePresetSvg(user.avatarPreset);
      if (resolved) return sendUserAvatarSvg(reply, resolved.svg);
    }

    // 3) 默认预设：按用户名哈希稳定分配，保证同一客服始终同一头像
    const fallback = await resolvePresetSvg(
      defaultUserAvatarPreset(user.username).id,
    );
    return sendUserAvatarSvg(reply, fallback?.svg ?? fallbackPresetSvg(defaultUserAvatarPreset(user.username)));
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
      const svg = await fetchDiceBearSvg(
        params.data.style,
        params.data.seed,
      );
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

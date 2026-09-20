/**
 * 用户头像服务（application 层）。
 *
 * 自定义上传 = 文件落盘 + 事务（storedFiles + users + 审计）+ 失败补偿删除；
 * 读取按「自定义上传 > 平台预设 > 用户名哈希默认」三级回落，预设经
 * DiceBear 代理取 SVG，上游不可达时用本地降级，端点始终有内容。
 */
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { FileStorage } from "../../../infrastructure/file_storage/types.js";
import { userAvatarUrl } from "./identity-service.js";
import {
  defaultUserAvatarPreset,
  fallbackPresetSvg,
  userAvatarPresetById,
} from "./avatar-presets.js";
import { fetchDiceBearSvg } from "./dicebear-avatars.js";

/** 头像文件存储端口（复用平台 FileStorage seam；interface 不感知驱动） */
export type AvatarFileStore = FileStorage;

/** 上传自定义头像：写文件 → 事务更新 → 失败补偿删除；返回头像 URL */
export async function uploadUserAvatar(
  db: NodePgDatabase<typeof schema>,
  fileStorage: AvatarFileStore,
  input: {
    userId: string;
    filename: string;
    mimeType: string;
    buffer: Buffer;
    sourceIp: string;
  },
): Promise<{ status: "ok"; avatarUrl: string | null }> {
  const stored = await fileStorage.write(
    Readable.from(input.buffer),
    input.filename,
    input.mimeType,
  );
  let avatarUpdatedAt = new Date();
  try {
    await db.transaction(async (transaction) => {
      await transaction.insert(schema.storedFiles).values({
        fileId: stored.fileId,
        ownerModule: "identity",
        originalName: stored.originalName,
        mimeType: stored.mimeType,
        size: stored.size,
        checksum: stored.checksum,
        storageKey: stored.storageKey,
        createdByUserId: input.userId,
      });
      const updatedRows = await transaction
        .update(schema.users)
        .set({
          avatarFileId: stored.fileId,
          // 上传与预设二选一：自定义上传生效时清掉预设引用
          avatarPreset: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.userId, input.userId))
        .returning({ updatedAt: schema.users.updatedAt });
      const updatedUser = updatedRows[0];
      if (!updatedUser) {
        throw new Error(`user ${input.userId} does not exist`);
      }
      avatarUpdatedAt = updatedUser.updatedAt;
      await transaction.insert(schema.auditEvents).values({
        auditId: randomUUID(),
        actorUserId: input.userId,
        eventType: "identity.avatar_updated",
        subjectType: "user",
        subjectId: input.userId,
        sourceIp: input.sourceIp,
        metadata: { fileId: stored.fileId },
      });
    });
  } catch (reason) {
    await fileStorage.remove(stored.storageKey).catch(() => undefined);
    throw reason;
  }
  return {
    status: "ok",
    avatarUrl: userAvatarUrl({
      userId: input.userId,
      updatedAt: avatarUpdatedAt,
    }),
  };
}

export type UserAvatarContent =
  | { kind: "file"; mimeType: string; stream: NodeJS.ReadableStream }
  | { kind: "svg"; svg: string };

/** 解析用户头像内容（三级回落）；用户不存在时返回 undefined */
export async function resolveUserAvatar(
  db: NodePgDatabase<typeof schema>,
  fileStorage: AvatarFileStore | undefined,
  userId: string,
): Promise<UserAvatarContent | undefined> {
  const rows = await db
    .select({
      username: schema.users.username,
      avatarPreset: schema.users.avatarPreset,
      storageKey: schema.storedFiles.storageKey,
      mimeType: schema.storedFiles.mimeType,
    })
    .from(schema.users)
    .leftJoin(
      schema.storedFiles,
      eq(schema.storedFiles.fileId, schema.users.avatarFileId),
    )
    .where(eq(schema.users.userId, userId))
    .limit(1);
  const user = rows[0];
  if (!user) return undefined;

  // 1) 自定义上传（文件丢失时继续回落后续来源，不 404）
  if (fileStorage && user.storageKey) {
    if (await fileStorage.exists(user.storageKey)) {
      return {
        kind: "file",
        mimeType: user.mimeType ?? "image/jpeg",
        stream: fileStorage.read(user.storageKey),
      };
    }
  }

  // 2) 已选平台预设（未知 id 时回落默认）
  if (user.avatarPreset) {
    const resolved = await resolvePresetSvg(user.avatarPreset);
    if (resolved) return { kind: "svg", svg: resolved.svg };
  }

  // 3) 默认预设：按用户名哈希稳定分配，保证同一客服始终同一头像
  const fallback = await resolvePresetSvg(
    defaultUserAvatarPreset(user.username).id,
  );
  return {
    kind: "svg",
    svg:
      fallback?.svg ??
      fallbackPresetSvg(defaultUserAvatarPreset(user.username)),
  };
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

/**
 * 客服头像端点集成测试
 * 验证：预设清单、默认预设（按用户名哈希）、预设选择/清除、
 * 自定义上传与展示优先级（上传 > 预设 > 默认）。
 */
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import { LocalFileStorage } from "../infrastructure/file_storage/local-file-storage.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { createClosedUser } from "../modules/identity/application/identity-service.js";
import { USER_AVATAR_PRESETS } from "../modules/identity/application/avatar-presets.js";
import { registerIdentityRoutes } from "../modules/identity/interface/http-routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

/** 1x1 PNG（合法的最小 PNG 文件） */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

integration("staff avatar endpoint", () => {
  let postgres: Postgres;
  let server: FastifyInstance;
  let storageRoot: string;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const username = `avatar-staff-${suffix}`;
  const cookieHolder: { cookie: string } = { cookie: "" };
  let userId = "";

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "staff-avatar-test"),
    );
    storageRoot = mkdtempSync(join(tmpdir(), "staff-avatar-test-"));
    server = Fastify();
    await server.register(multipart, {
      limits: { fileSize: 10 * 1_024 * 1_024, files: 1 },
    });
    registerIdentityRoutes(
      server,
      postgres.db,
      new LocalFileStorage(storageRoot),
    );
    await server.ready();

    // 创建封闭用户 → 登录 → 改密，拿到业务身份 cookie
    const user = await createClosedUser(
      postgres.db,
      username,
      "Avatar-pass-1!",
    );
    userId = user.userId;
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password: "Avatar-pass-1!" },
    });
    const cookie =
      (login.headers["set-cookie"] as unknown as string).split(";")[0] ?? "";
    expect(cookie).toBeTruthy();
    const changed = await server.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: {
        currentPassword: "Avatar-pass-1!",
        newPassword: "Avatar-pass-2!",
      },
    });
    expect(changed.statusCode).toBe(200);
    cookieHolder.cookie = cookie;
  });

  afterAll(async () => {
    await server.close();
    await postgres.db
      .delete(schema.storedFiles)
      .where(eq(schema.storedFiles.createdByUserId, userId));
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.actorUserId, userId));
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, userId));
    await postgres.db
      .delete(schema.userSessions)
      .where(eq(schema.userSessions.userId, userId));
    await postgres.db
      .delete(schema.users)
      .where(eq(schema.users.userId, userId));
    await postgres.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("lists the platform avatar presets", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/users/avatar-presets",
      headers: { cookie: cookieHolder.cookie },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      presets: Array<{ id: string; name: string; seed: string; svgUrl: string }>;
    };
    expect(payload.presets).toHaveLength(USER_AVATAR_PRESETS.length);
    // 预设不再内嵌 SVG：返回平台代理 URL（DiceBear Blobs seed）
    expect(payload.presets[0]?.svgUrl).toContain(
      "/api/v1/avatars/dicebear/blobs/",
    );
    expect(payload.presets[0]?.seed).toBeTruthy();
  });

  it("serves the deterministic default preset for a fresh user", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/users/${userId}/avatar`,
      headers: { cookie: cookieHolder.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    // 预设经 DiceBear 代理取图；上游不可达时回退本地降级 SVG——
    // 两种情况都必须是合法 SVG 且确定性（同一用户同一头像）。
    expect(response.body).toContain("<svg");
    const again = await server.inject({
      method: "GET",
      url: `/api/v1/users/${userId}/avatar`,
      headers: { cookie: cookieHolder.cookie },
    });
    expect(again.body).toBe(response.body);
  });

  it("applies, rejects unknown, and clears a preset override", async () => {
    const preset = USER_AVATAR_PRESETS[1];
    if (!preset) throw new Error("missing preset fixture");
    const applied = await server.inject({
      method: "PATCH",
      url: "/api/v1/auth/avatar",
      headers: { cookie: cookieHolder.cookie },
      payload: { preset: preset.id },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      user: { avatarPreset: preset.id },
    });
    const shown = await server.inject({
      method: "GET",
      url: `/api/v1/users/${userId}/avatar`,
      headers: { cookie: cookieHolder.cookie },
    });
    // 选中预设后头像切换为该预设的确定性 SVG（代理或本地降级）
    expect(shown.body).toContain("<svg");
    expect(shown.body).not.toBe("");

    const rejected = await server.inject({
      method: "PATCH",
      url: "/api/v1/auth/avatar",
      headers: { cookie: cookieHolder.cookie },
      payload: { preset: "not-a-preset" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "avatar_preset_unknown" });

    const cleared = await server.inject({
      method: "PATCH",
      url: "/api/v1/auth/avatar",
      headers: { cookie: cookieHolder.cookie },
      payload: { preset: null },
    });
    expect(cleared.statusCode).toBe(200);
    const restored = await server.inject({
      method: "GET",
      url: `/api/v1/users/${userId}/avatar`,
      headers: { cookie: cookieHolder.cookie },
    });
    expect(restored.body).toContain("<svg");
  });

  it("uploads a custom avatar which wins over presets", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([TINY_PNG], { type: "image/png" }),
      "tiny.png",
    );
    const uploaded = await server.inject({
      method: "POST",
      url: "/api/v1/auth/avatar",
      headers: { cookie: cookieHolder.cookie },
      payload: form,
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({
      // 头像 URL 附带基于 updated_at 的版本参数
      avatarUrl: expect.stringContaining(`/api/v1/users/${userId}/avatar?v=`),
    });

    const shown = await server.inject({
      method: "GET",
      url: `/api/v1/users/${userId}/avatar`,
      headers: { cookie: cookieHolder.cookie },
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.headers["content-type"]).toContain("image/png");
    expect(Buffer.compare(shown.rawPayload, TINY_PNG)).toBe(0);

    // 选择预设会清掉上传引用，显示回落为预设（确定性 SVG）
    const preset = USER_AVATAR_PRESETS[2];
    if (!preset) throw new Error("missing preset fixture");
    const applied = await server.inject({
      method: "PATCH",
      url: "/api/v1/auth/avatar",
      headers: { cookie: cookieHolder.cookie },
      payload: { preset: preset.id },
    });
    expect(applied.statusCode).toBe(200);
    const shownAgain = await server.inject({
      method: "GET",
      url: `/api/v1/users/${userId}/avatar`,
      headers: { cookie: cookieHolder.cookie },
    });
    expect(shownAgain.headers["content-type"]).toContain("image/svg+xml");
    expect(shownAgain.body).toContain("<svg");
  });
});

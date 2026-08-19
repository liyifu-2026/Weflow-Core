import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { LocalFileStorage } from "../infrastructure/file_storage/local-file-storage.js";
import { createClosedUser } from "../modules/identity/application/identity-service.js";
import { registerIdentityRoutes } from "../modules/identity/interface/http-routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

/** 1×1 透明 PNG（最小合法 PNG） */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function multipartBody(buffer: Buffer, filename: string, mime: string) {
  const boundary = `----avatar-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, buffer, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

integration("客服头像（identity avatar）", () => {
  let postgres: Postgres;
  let server: FastifyInstance;
  let storage: LocalFileStorage;
  let storageDir: string;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const password = "Avatar-contract-1!";
  const nextPassword = "Avatar-contract-2!";
  let userId = "";
  let cookie = "";

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "avatar-test"),
    );
    storageDir = mkdtempSync(join(tmpdir(), "weflow-avatar-test-"));
    storage = new LocalFileStorage(storageDir);
    server = Fastify();
    await server.register(multipart, {
      limits: { fileSize: 1_024 * 1_024, files: 1 },
    });
    registerIdentityRoutes(server, postgres.db, storage);
    await server.ready();
    const username = `avatar-${suffix}`;
    const created = await createClosedUser(postgres.db, username, password);
    userId = created.userId;
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password },
    });
    const setCookie = login.headers["set-cookie"];
    if (typeof setCookie !== "string") throw new Error("missing cookie");
    cookie = setCookie.split(";")[0] ?? "";
    const changed = await server.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: password, newPassword: nextPassword },
    });
    if (changed.statusCode !== 200) throw new Error("password change failed");
  });

  afterAll(async () => {
    await server.close();
    await postgres.db
      .delete(schema.storedFiles)
      .where(
        and(
          eq(schema.storedFiles.ownerModule, "identity"),
          eq(schema.storedFiles.createdByUserId, userId),
        ),
      );
    await postgres.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.actorUserId, userId));
    await postgres.db
      .delete(schema.userSessions)
      .where(eq(schema.userSessions.userId, userId));
    await postgres.db
      .delete(schema.users)
      .where(eq(schema.users.userId, userId));
    await postgres.close();
  });

  it("上传头像 → 201 avatarUrl；me 投影含 avatarUrl；读取内容字节一致", async () => {
    const { body, headers } = multipartBody(
      PNG_BYTES,
      "avatar.png",
      "image/png",
    );
    const upload = await server.inject({
      method: "POST",
      url: "/api/v1/auth/avatar",
      headers: { ...headers, cookie },
      payload: body,
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const avatarUrl = upload.json<{ avatarUrl: string }>().avatarUrl;
    expect(avatarUrl).toBe(`/api/v1/users/${userId}/avatar`);

    const me = await server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(
      me.json<{ user: { avatarUrl: string | null } }>().user.avatarUrl,
    ).toBe(avatarUrl);

    const read = await server.inject({
      method: "GET",
      url: avatarUrl,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers["content-type"]).toBe("image/png");
    expect(read.headers["cache-control"]).toBe("private, no-store");
    expect(read.rawPayload).toEqual(PNG_BYTES);
  });

  it("未登录读取头像 → 401；不存在用户 → 404", async () => {
    const anon = await server.inject({
      method: "GET",
      url: `/api/v1/users/${userId}/avatar`,
    });
    expect(anon.statusCode).toBe(401);

    const missing = await server.inject({
      method: "GET",
      url: `/api/v1/users/${randomUUID()}/avatar`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("非图片类型上传 → 400 avatar_unsupported_type", async () => {
    const { body, headers } = multipartBody(
      Buffer.from("hello"),
      "note.txt",
      "text/plain",
    );
    const upload = await server.inject({
      method: "POST",
      url: "/api/v1/auth/avatar",
      headers: { ...headers, cookie },
      payload: body,
    });
    expect(upload.statusCode).toBe(400);
    expect(upload.json<{ error: string }>().error).toBe(
      "avatar_unsupported_type",
    );
  });
});

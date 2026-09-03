// 一次性冒烟：对运行中的 core-api (127.0.0.1:3100) 验证素材空间完整链路。
// 创建临时用户 → 登录 → 上传/列表/改名/删除 → 清理全部临时数据后退出。
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../infrastructure/config/config.js";
import { createPostgres } from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { eq } from "drizzle-orm";

const BASE = "http://127.0.0.1:3100";
const fileStorageRoot = loadConfig().fileStorageRoot;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const password = "Smoke-asset-1!";
const nextPassword = "Smoke-asset-2!";
const username = `asset-smoke-${randomUUID().slice(0, 8)}`;

const postgres = createPostgres(
  process.env.DATABASE_URL ?? "",
  { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
);

function assert(condition: unknown, label: string): void {
  if (!condition) throw new Error(`SMOKE FAIL: ${label}`);
  console.log(`ok: ${label}`);
}

async function main() {
  // 建临时用户（closed 状态，与集成测试同路径）
  const { createClosedUser } = await import("../modules/identity/application/identity-service.js");
  const created = await createClosedUser(postgres.db, username, password);
  assert(created.userId, "临时用户已创建");

  // 登录 + 改密激活
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert(login.status === 200, `登录 ${login.status}`);
  const cookie = String(login.headers.get("set-cookie")).split(";")[0];
  const changed = await fetch(`${BASE}/api/v1/auth/change-password`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ currentPassword: password, newPassword: nextPassword }),
  });
  assert(changed.status === 200, `激活 ${changed.status}`);

  // 上传入空间
  const boundary = `----smoke-${randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="smoke.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await fetch(`${BASE}/api/v1/assets`, {
    method: "POST",
    headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    body: new Uint8Array(body),
  });
  const upBody = (await up.json()) as { asset?: { assetId: string; category: string } };
  assert(up.status === 201, `上传 ${up.status} ${JSON.stringify(upBody).slice(0, 200)}`);
  assert(upBody.asset?.category === "image", "分类推导为 image");
  const assetId = upBody.asset!.assetId;

  // 列表
  const list = await fetch(`${BASE}/api/v1/assets?category=image`, { headers: { cookie } });
  const listBody = (await list.json()) as { items: Array<{ assetId: string }> };
  assert(list.status === 200, `列表 ${list.status}`);
  assert(listBody.items.some((i) => i.assetId === assetId), "列表包含新素材");

  // 内容读取（字节一致）
  const content = await fetch(`${BASE}/api/v1/assets/${assetId}/content`, { headers: { cookie } });
  const bytes = Buffer.from(await content.arrayBuffer());
  assert(content.status === 200, `内容 ${content.status}`);
  assert(bytes.equals(png), "内容字节一致");

  // 改名 + 删除
  const renamed = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "冒烟改名" }),
  });
  assert(renamed.status === 200, `改名 ${renamed.status}`);
  const removed = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
    method: "DELETE",
    headers: { cookie },
  });
  assert(removed.status === 200, `删除 ${removed.status}`);
  const afterDelete = await fetch(`${BASE}/api/v1/assets/${assetId}`, { headers: { cookie } });
  assert(afterDelete.status === 404, "删除后不可见");

  console.log("SMOKE PASS: 素材空间链路在运行中的 core-api 上全部通过");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 清理临时用户产生的所有行
    try {
      const rows = await postgres.db
        .select({ userId: schema.users.userId })
        .from(schema.users)
        .where(eq(schema.users.username, username));
      for (const row of rows) {
        const files = await postgres.db
          .select({ fileId: schema.storedFiles.fileId, storageKey: schema.storedFiles.storageKey })
          .from(schema.storedFiles)
          .where(eq(schema.storedFiles.createdByUserId, row.userId));
        for (const file of files) {
          await postgres.db.delete(schema.assetsItems).where(eq(schema.assetsItems.fileId, file.fileId));
          await postgres.db.delete(schema.storedFiles).where(eq(schema.storedFiles.fileId, file.fileId));
          await unlink(join(fileStorageRoot, "assets", file.storageKey)).catch(() => undefined);
        }
        await postgres.db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, row.userId));
        await postgres.db.delete(schema.userSessions).where(eq(schema.userSessions.userId, row.userId));
        await postgres.db.delete(schema.users).where(eq(schema.users.userId, row.userId));
      }
      console.log("cleanup: 临时数据已清理");
    } catch (error) {
      console.error("cleanup failed:", error);
    } finally {
      await postgres.close();
    }
  });

/**
 * 素材空间集成测试
 *
 * 覆盖：本机上传入空间（分类推导）、分页浏览（keyset + 搜索）、
 * 重命名/软删除整理、内容流式读取、素材转发发送（manual reply assetId →
 * mediaAssets 确定性派生 + 幂等重放）。
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { LocalFileStorage } from "../infrastructure/file_storage/local-file-storage.js";
import {
  acceptHandoff,
  createHandoff,
} from "../modules/handoff/application/handoff-service.js";
import { createClosedUser } from "../modules/identity/application/identity-service.js";
import { registerIdentityRoutes } from "../modules/identity/interface/http-routes.js";
import { registerAssetRoutes } from "../modules/assets/interface/http-routes.js";
import { registerConversationRoutes } from "../modules/conversations/interface/http-routes.js";
import { assetOutboundMediaId } from "../modules/assets/application/asset-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

/** 1×1 透明 PNG（最小合法 PNG） */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const TXT_BYTES = Buffer.from("asset-space-integration-test", "utf8");

function multipartBody(
  buffer: Buffer,
  filename: string,
  mime: string,
): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----asset-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, buffer, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

integration("素材空间（assets）", () => {
  let postgres: Postgres;
  let server: FastifyInstance;
  let storageDir: string;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const password = "Asset-space-contract-1!";
  const nextPassword = "Asset-space-contract-2!";
  let userId = "";
  let cookie = "";
  const conversationIds: string[] = [];
  const contactIds: string[] = [];
  const assetIds: string[] = [];

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "asset-space-test"),
    );
    storageDir = mkdtempSync(join(tmpdir(), "weflow-asset-test-"));
    server = Fastify();
    await server.register(multipart, {
      limits: { fileSize: 100 * 1_024 * 1_024, files: 1 },
    });
    registerIdentityRoutes(server, postgres.db);
    registerAssetRoutes(server, postgres.db, new LocalFileStorage(storageDir));
    registerConversationRoutes(server, postgres.db);
    await server.ready();
    const username = `asset-${suffix}`;
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
      .delete(schema.notificationOutbox)
      .where(
        inArray(schema.notificationOutbox.conversationId, conversationIds),
      );
    await postgres.db
      .delete(schema.mediaAssets)
      .where(inArray(schema.mediaAssets.conversationId, conversationIds));
    await postgres.db
      .delete(schema.assetsItems)
      .where(inArray(schema.assetsItems.assetId, assetIds));
    await postgres.db
      .delete(schema.storedFiles)
      .where(
        and(
          eq(schema.storedFiles.ownerModule, "asset"),
          eq(schema.storedFiles.createdByUserId, userId),
        ),
      );
    await postgres.db
      .delete(schema.mediaAssets)
      .where(inArray(schema.mediaAssets.conversationId, conversationIds));
    // 先删记忆水位：capture_states.watermark_message_id 外键引用 messages，
    // 顺序反了会因 FK 约束删不掉消息（清理阶段报错）
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(
        inArray(schema.memoryCaptureStates.conversationId, conversationIds),
      );
    await postgres.db
      .delete(schema.messages)
      .where(inArray(schema.messages.conversationId, conversationIds));
    await postgres.db
      .delete(schema.handoffEvents)
      .where(inArray(schema.handoffEvents.conversationId, conversationIds));
    await postgres.db
      .delete(schema.handoffStates)
      .where(inArray(schema.handoffStates.conversationId, conversationIds));
    await postgres.db
      .delete(schema.handoffCycles)
      .where(inArray(schema.handoffCycles.conversationId, conversationIds));
    await postgres.db
      .delete(schema.agentTurns)
      .where(inArray(schema.agentTurns.conversationId, conversationIds));
    await postgres.db
      .delete(schema.conversations)
      .where(inArray(schema.conversations.conversationId, conversationIds));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(inArray(schema.contactProfiles.contactId, contactIds));
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

  async function upload(
    filename: string,
    mime: string,
    bytes: Buffer,
  ): Promise<{ assetId: string; category: string; name: string }> {
    const { body, headers } = multipartBody(bytes, filename, mime);
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: { cookie, ...headers },
      body,
    });
    expect(response.statusCode).toBe(201);
    const asset = response.json<{
      asset: { assetId: string; category: string; name: string };
    }>().asset;
    assetIds.push(asset.assetId);
    return asset;
  }

  it("上传图片 → category=image；上传非图片 → category=file；内容字节一致", async () => {
    const image = await upload("海报.png", "image/png", PNG_BYTES);
    expect(image.category).toBe("image");
    expect(image.name).toBe("海报.png");
    const file = await upload("说明.txt", "text/plain", TXT_BYTES);
    expect(file.category).toBe("file");
    const content = await server.inject({
      method: "GET",
      url: `/api/v1/assets/${image.assetId}/content`,
      headers: { cookie },
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(content.rawPayload).equals(PNG_BYTES)).toBe(true);
  });

  it("列表按 category 过滤 + 名称搜索 + keyset 分页不重不漏", async () => {
    await upload("报价单-甲.pdf", "application/pdf", TXT_BYTES);
    await upload("报价单-乙.pdf", "application/pdf", TXT_BYTES);
    await upload("报价单-丙.pdf", "application/pdf", TXT_BYTES);
    const searched = await server.inject({
      method: "GET",
      url:
        "/api/v1/assets?category=file&search=" +
        encodeURIComponent("报价单-乙"),
      headers: { cookie },
    });
    expect(searched.statusCode).toBe(200);
    const searchedItems = searched.json<{ items: Array<{ name: string }> }>()
      .items;
    expect(searchedItems.some((item) => item.name === "报价单-乙.pdf")).toBe(
      true,
    );
    expect(searchedItems.some((item) => item.name === "报价单-甲.pdf")).toBe(
      false,
    );

    const page1 = await server.inject({
      method: "GET",
      url: "/api/v1/assets?category=file&limit=2",
      headers: { cookie },
    });
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json<{
      items: Array<{ assetId: string }>;
      nextCursor: string | null;
    }>();
    expect(page1Body.items).toHaveLength(2);
    expect(page1Body.nextCursor).toBeTruthy();
    const page2 = await server.inject({
      method: "GET",
      url: `/api/v1/assets?category=file&limit=2&cursor=${encodeURIComponent(page1Body.nextCursor ?? "")}`,
      headers: { cookie },
    });
    expect(page2.statusCode).toBe(200);
    const page2Body = page2.json<{
      items: Array<{ assetId: string }>;
      nextCursor: string | null;
    }>();
    const seen = new Set(
      [...page1Body.items, ...page2Body.items].map((item) => item.assetId),
    );
    expect(seen.size).toBe(page1Body.items.length + page2Body.items.length);
    const imageOnly = await server.inject({
      method: "GET",
      url: "/api/v1/assets?category=image&limit=100",
      headers: { cookie },
    });
    const imageItems = imageOnly.json<{ items: Array<{ category: string }> }>()
      .items;
    expect(imageItems.every((item) => item.category === "image")).toBe(true);
  });

  it("重命名与软删除：改名生效、删除后列表与内容均不可见", async () => {
    const asset = await upload("旧名.txt", "text/plain", TXT_BYTES);
    const renamed = await server.inject({
      method: "PATCH",
      url: `/api/v1/assets/${asset.assetId}`,
      headers: { cookie },
      payload: { name: "产品说明书 v2" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ asset: { name: string } }>().asset.name).toBe(
      "产品说明书 v2",
    );
    const deleted = await server.inject({
      method: "DELETE",
      url: `/api/v1/assets/${asset.assetId}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(200);
    const afterDelete = await server.inject({
      method: "GET",
      url: `/api/v1/assets/${asset.assetId}`,
      headers: { cookie },
    });
    expect(afterDelete.statusCode).toBe(404);
    const contentAfterDelete = await server.inject({
      method: "GET",
      url: `/api/v1/assets/${asset.assetId}/content`,
      headers: { cookie },
    });
    expect(contentAfterDelete.statusCode).toBe(404);
    const audit = await postgres.db
      .select({ eventType: schema.auditEvents.eventType })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, asset.assetId));
    expect(audit.some((row) => row.eventType === "asset.renamed")).toBe(true);
    expect(audit.some((row) => row.eventType === "asset.deleted")).toBe(true);
  });

  it("未认证访问被拒绝", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/assets",
    });
    expect([401, 403]).toContain(response.statusCode);
  });

  it("素材转发发送：manual reply assetId → mediaAssets 派生；重放幂等；素材不存在 404", async () => {
    // 播种会话 + 人工接管（当前用户为 assignee）
    const conversationId = `channel:asset-send-${suffix}`;
    const contactId = `contact:asset-send-${suffix}`;
    conversationIds.push(conversationId);
    contactIds.push(contactId);
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `asset-send-${suffix}`,
      channelDisplayName: "客户-素材",
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `asset-send-${suffix}`,
    });
    await postgres.db.insert(schema.messages).values({
      messageId: `asset-message:${conversationId}:${randomUUID()}`,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text: "请发一下产品图。",
      processingState: "received",
      idempotencyKey: `asset-message:${conversationId}:${randomUUID()}`,
      occurredAt: new Date(),
      traceId: `asset-message:${conversationId}:${randomUUID()}`,
    });
    const handoff = await createHandoff(postgres.db, {
      conversationId,
      actorUserId: "system-agent",
      clientRequestId: randomUUID(),
      summary: "需要人工发送素材",
      sourceIp: "test",
    });
    expect(handoff.status).toBe("ok");
    const takeover = await acceptHandoff(postgres.db, {
      conversationId,
      actorUserId: userId,
      clientRequestId: randomUUID(),
      summary: "接管发送素材",
      sourceIp: "test",
    });
    expect(takeover.status).toBe("ok");

    const asset = await upload("产品图.png", "image/png", PNG_BYTES);
    const clientRequestId = randomUUID();
    const send1 = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      headers: { cookie },
      payload: { text: "", clientRequestId, assetId: asset.assetId },
    });
    expect(send1.statusCode).toBe(202);
    const send1Body = send1.json<{
      message: { messageId: string; contentType: string };
    }>();
    expect(send1Body.message.contentType).toBe("media");
    const mediaRows = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, send1Body.message.messageId));
    expect(mediaRows).toHaveLength(1);
    expect(mediaRows[0]?.kind).toBe("image");
    expect(mediaRows[0]?.mediaId).toBe(
      assetOutboundMediaId(asset.assetId, clientRequestId),
    );
    const originalFileId = mediaRows[0]?.originalFileId;
    const storedRow = originalFileId
      ? (
          await postgres.db
            .select({ ownerModule: schema.storedFiles.ownerModule })
            .from(schema.storedFiles)
            .where(eq(schema.storedFiles.fileId, originalFileId))
        )[0]
      : undefined;
    expect(storedRow?.ownerModule).toBe("asset");

    // 幂等重放：同 clientRequestId → replayed=true，不新增 mediaAssets
    const send2 = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      headers: { cookie },
      payload: { text: "", clientRequestId, assetId: asset.assetId },
    });
    expect(send2.statusCode).toBe(202);
    expect(send2.json<{ replayed: boolean }>().replayed).toBe(true);
    const mediaRowsAfterReplay = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, send1Body.message.messageId));
    expect(mediaRowsAfterReplay).toHaveLength(1);

    // 同素材再次发送（新 clientRequestId）→ 新 mediaId，不冲突
    const send3 = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      headers: { cookie },
      payload: {
        text: "",
        clientRequestId: randomUUID(),
        assetId: asset.assetId,
      },
    });
    expect(send3.statusCode).toBe(202);

    // 素材不存在 → 404
    const sendMissing = await server.inject({
      method: "POST",
      url: `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      headers: { cookie },
      payload: {
        text: "",
        clientRequestId: randomUUID(),
        assetId: randomUUID(),
      },
    });
    expect(sendMissing.statusCode).toBe(404);
    expect(sendMissing.json<{ error: string }>().error).toBe("asset_not_found");
  });
});

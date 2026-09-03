/**
 * 回归测试：出站队列单条隔离（防队头堵塞）
 *
 * 背景：微信 Channel Host 曾对契约 mention payload（mentionContactRefs）返回
 * HTTP 400 且不落任何操作；出站循环在 reconcile create() 处每轮抛异常中断，
 * 排在毒消息后面的所有消息被冻结在 pending/submitting（UI 永远「发送中」）。
 *
 * 契约（ChannelSendRejectedError 语义）：
 * - Host 以 400/413/422 明确拒收当前消息 → 该消息置 failed 终态，继续处理后续
 * - 传输/服务端故障（5xx、超时、网络）→ 仍中断整轮，等待下一轮重试
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { ChannelSendRejectedError } from "../modules/channel/contracts/channel-send-operations.js";
import type { ChannelSendOperations } from "../modules/channel/contracts/channel-send-operations.js";
import { processOutboundMessages } from "../modules/conversations/application/process-outbound-messages.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const logger = createLogger({ logLevel: "silent" }, "outbound-isolation-test");

integration("出站队列单条隔离", () => {
  let postgres: Postgres | undefined;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const created: { conversationId: string; contactId: string }[] = [];

  beforeAll(() => {
    postgres = createPostgres(databaseUrl ?? "", logger);
  });

  afterAll(async () => {
    if (postgres) {
      for (const { conversationId, contactId } of created) {
        await postgres.db
          .delete(schema.messages)
          .where(eq(schema.messages.conversationId, conversationId));
        await postgres.db
          .delete(schema.conversations)
          .where(eq(schema.conversations.conversationId, conversationId));
        await postgres.db
          .delete(schema.contactProfiles)
          .where(eq(schema.contactProfiles.contactId, contactId));
      }
      await postgres.close();
    }
  });

  /** 每个用例独立会话，避免用例间残留消息干扰处理顺序 */
  async function createConversation(tag: string): Promise<string> {
    if (!postgres) throw new Error("postgres not ready");
    const conversationId = `channel:outbound-iso-${suffix}-${tag}`;
    const contactId = `contact:channel:outbound-iso-${suffix}-${tag}`;
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `outbound-iso-${suffix}-${tag}-contact`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `outbound-iso-${suffix}-${tag}-ref`,
    });
    created.push({ conversationId, contactId });
    return conversationId;
  }

  async function insertOutbound(
    conversationId: string,
    tag: string,
    createdAt: Date,
  ): Promise<string> {
    if (!postgres) throw new Error("postgres not ready");
    const messageId = `outbound-iso:${suffix}:${tag}`;
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      channelEventId: null,
      channelMessageId: null,
      direction: "outbound",
      actorType: "user",
      actorId: null,
      contentType: "text",
      channelType: 1,
      text: `隔离测试消息 ${tag}`,
      isSelf: true,
      processingState: "not_applicable",
      sendState: "pending",
      idempotencyKey: messageId,
      occurredAt: createdAt,
      createdAt,
      traceId: "outbound-isolation-test",
    });
    return messageId;
  }

  it("400 毒消息被隔离为 failed，后续消息正常提交", async () => {
    if (!postgres) throw new Error("postgres not ready");
    const conversationId = await createConversation("reject");
    const poisonId = await insertOutbound(
      conversationId,
      `poison-${suffix}`,
      new Date(Date.now() - 60_000),
    );
    const goodId = await insertOutbound(
      conversationId,
      `good-${suffix}`,
      new Date(Date.now() - 30_000),
    );

    const create = vi.fn<ChannelSendOperations["create"]>((input) => {
      if (
        input.payload.kind === "text" &&
        input.payload.text.includes("poison")
      ) {
        throw new ChannelSendRejectedError(
          400,
          "Host rejected request with 400",
        );
      }
      return Promise.resolve({
        operationId: input.operationId,
        conversationRef: input.conversationRef,
        payload: input.payload,
        state: "pending" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    const client: ChannelSendOperations = {
      get: vi.fn(() => Promise.resolve(undefined)),
      create,
    };

    await processOutboundMessages(postgres.db, client, { logger });

    const [poison] = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, poisonId));
    if (!poison) throw new Error("poison message missing");
    expect(poison.sendState).toBe("failed");
    expect(poison.sendError).toBe("channel_rejected_http_400");

    const [good] = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, goodId));
    if (!good) throw new Error("good message missing");
    expect(good.sendState).toBe("submitting");
  });

  it("5xx 传输故障不标记 failed，本轮中断（等待下轮重试）", async () => {
    if (!postgres) throw new Error("postgres not ready");
    const conversationId = await createConversation("server-error");
    const firstId = await insertOutbound(
      conversationId,
      `server-error-${suffix}`,
      new Date(Date.now() - 60_000),
    );
    const secondId = await insertOutbound(
      conversationId,
      `after-error-${suffix}`,
      new Date(Date.now() - 30_000),
    );

    const create = vi.fn<ChannelSendOperations["create"]>(() => {
      throw new Error("channel_http_error: Host returned 503");
    });
    const client: ChannelSendOperations = {
      get: vi.fn(() => Promise.resolve(undefined)),
      create,
    };

    await expect(
      processOutboundMessages(postgres.db, client, { logger, conversationId }),
    ).rejects.toThrow("Host returned 503");

    const [first] = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, firstId));
    if (!first) throw new Error("first message missing");
    expect(first.sendState).toBe("submitting");
    expect(first.sendError).toBeNull();

    const [second] = await postgres.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageId, secondId));
    if (!second) throw new Error("second message missing");
    expect(second.sendState).toBe("pending");
  });
});

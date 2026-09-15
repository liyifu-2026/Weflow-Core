/**
 * search_chat_history 工具集成测试（真库）：
 * 说话者昵称解析、关键词/时间窗过滤、截断与总数、参数缺失报错。
 */
import { like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { executeToolPlan } from "../modules/agent/application/execute-tool-plan.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("search_chat_history tool", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationId = `channel:history-tool-${suffix}`;
  const contactId = `contact:channel:history-tool-${suffix}`;
  // 群成员资料：昵称 Leaif（wxid 结尾 s3si12），供昵称→wxid 解析断言
  const leaifWxid = `wxid_history_leaif_${suffix}`;
  const otherWxid = `wxid_history_other_${suffix}`;

  let sequence = 0;
  async function seedExecution(
    argumentsValue: Record<string, unknown>,
  ): Promise<string> {
    sequence += 1;
    const executionId = `agent-tool:history-turn-${suffix}:${String(sequence)}`;
    const turnId = `history-turn-${suffix}:${String(sequence)}`;
    const triggerId = `history-trigger-${suffix}:${String(sequence)}`;
    await postgres.db.insert(schema.messages).values({
      messageId: triggerId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      contentType: "text",
      channelType: 1,
      text: `trigger ${String(sequence)}`,
      processingState: "received",
      idempotencyKey: triggerId,
      occurredAt: new Date(),
      traceId: triggerId,
    });
    await postgres.db.insert(schema.agentTurns).values({
      turnId,
      triggerMessageId: triggerId,
      conversationId,
      status: "tool_planned",
      traceId: turnId,
    });
    await postgres.db.insert(schema.toolExecutions).values({
      executionId,
      turnId,
      conversationId,
      toolName: "search_chat_history",
      status: "planned",
      idempotencyKey: executionId,
      arguments: argumentsValue,
    });
    return executionId;
  }

  async function insertInbound(
    messageId: string,
    actorId: string | null,
    text: string,
    ageMinutes: number,
  ): Promise<void> {
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId,
      direction: "inbound",
      actorType: "channel_contact",
      actorId,
      contentType: "text",
      channelType: 1,
      text,
      processingState: "received",
      idempotencyKey: messageId,
      occurredAt: new Date(Date.now() - ageMinutes * 60_000),
      traceId: messageId,
    });
  }

  beforeAll(async () => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "history-tool-test"),
    );
    await postgres.db.insert(schema.contactProfiles).values([
      {
        contactId,
        channel: "channel",
        channelContactId: `history-tool-${suffix}`,
      },
      {
        contactId: `contact:channel:${leaifWxid}`,
        channel: "channel",
        channelContactId: leaifWxid,
        channelNickname: "Leaif",
      },
      {
        contactId: `contact:channel:${otherWxid}`,
        channel: "channel",
        channelContactId: otherWxid,
        channelNickname: "小白",
      },
    ]);
    await postgres.db
      .insert(schema.conversations)
      .values({
        conversationId,
        contactId,
        channel: "channel",
        channelConversationId: `history-tool-${suffix}`,
      });
    // Leaif 两条（一条命中关键词），小白一条，5 天前的一条旧消息（72h 窗外）
    await insertInbound(`hist-${suffix}-1`, leaifWxid, "v9打不开，报错误码2272", 10);
    await insertInbound(`hist-${suffix}-2`, leaifWxid, "重启了还是不行", 8);
    await insertInbound(`hist-${suffix}-3`, otherWxid, "我也有这个问题", 5);
    await insertInbound(`hist-${suffix}-4`, leaifWxid, "错误码12535又来了", 7200);
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.toolExecutions)
      .where(like(schema.toolExecutions.conversationId, conversationId));
    await postgres.db
      .delete(schema.agentTurns)
      .where(like(schema.agentTurns.conversationId, conversationId));
    await postgres.db
      .delete(schema.messages)
      .where(like(schema.messages.conversationId, conversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(like(schema.conversations.conversationId, conversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(
        like(schema.contactProfiles.contactId, `contact:channel:history-tool-${suffix}%`),
      );
    await postgres.db
      .delete(schema.contactProfiles)
      .where(
        like(schema.contactProfiles.channelContactId, `wxid_history_%${suffix}`),
      );
    await postgres.close();
  });

  it("scope=speaker 按昵称解析并只返回该成员的消息（带可读名字）", async () => {
    const executionId = await seedExecution({
      scope: "speaker",
      speaker: "Leaif",
      limit: "10",
    });
    const result = await executeToolPlan(postgres.db, executionId);
    expect(result.status).toBe("succeeded");
    const messages = result.result?.messages as Array<{
      speaker: string;
      text: string;
    }>;
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.speaker === "Leaif")).toBe(true);
    expect(messages[0]?.text).toContain("重启了还是不行");
  });

  it("scope=group + keyword + before_hours：过滤关键词且排除时间窗外旧消息", async () => {
    const executionId = await seedExecution({
      scope: "group",
      keyword: "错误码",
      before_hours: "2",
    });
    const result = await executeToolPlan(postgres.db, executionId);
    expect(result.status).toBe("succeeded");
    expect(result.result?.total_matched).toBe(1);
    const messages = result.result?.messages as Array<{ text: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain("错误码2272");
  });

  it("scope=speaker 未给 speaker：落 failed（invalid_history_scope）", async () => {
    const executionId = await seedExecution({ scope: "speaker" });
    const result = await executeToolPlan(postgres.db, executionId);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("invalid_history_scope");
  });
});

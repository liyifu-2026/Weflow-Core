/**
 * 集成测试：agent 上下文的出站送达可见性（发送期插话闸门配套）
 *
 * 契约：
 * - held 的 agent 回复分段以「已准备但未送达」提示块进入 prompt（24h 内），
 *   新决策可改写重发、原样补发或放弃；>24h 的不注入；查询失败静默降级
 * - 20 条原文窗口内，未送达（非 confirmed/observed）的出站消息渲染为
 *   「…（未送达）」，不得冒充「已说出口的话」；已送达与入站消息无标注
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { buildAgentContext } from "../modules/agent/application/agent-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const logger = createLogger({ logLevel: "silent" }, "held-visibility-test");

integration("agent 上下文出站送达可见性", () => {
  let postgres: Postgres | undefined;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const created: { conversationId: string; contactId: string }[] = [];

  beforeAll(() => {
    postgres = createPostgres(databaseUrl ?? "", logger);
  });

  afterAll(async () => {
    if (!postgres) return;
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
  });

  async function createConversation(tag: string): Promise<string> {
    if (!postgres) throw new Error("postgres not ready");
    const conversationId = `channel:held-vis-${suffix}-${tag}`;
    const contactId = `contact:channel:held-vis-${suffix}-${tag}`;
    await postgres.db.insert(schema.contactProfiles).values({
      contactId,
      channel: "channel",
      channelContactId: `held-vis-${suffix}-${tag}-contact`,
    });
    await postgres.db.insert(schema.conversations).values({
      conversationId,
      contactId,
      channel: "channel",
      channelConversationId: `held-vis-${suffix}-${tag}-ref`,
    });
    created.push({ conversationId, contactId });
    return conversationId;
  }

  async function insertMessage(input: {
    conversationId: string;
    tag: string;
    direction: "inbound" | "outbound";
    sendState: string | null;
    text: string;
    replyBatchId?: string;
    replySequence?: number;
    sendUpdatedAt?: Date;
  }): Promise<void> {
    if (!postgres) throw new Error("postgres not ready");
    const messageId = `held-vis:${suffix}:${input.tag}`;
    const at = new Date(Date.now() - 10_000);
    await postgres.db.insert(schema.messages).values({
      messageId,
      conversationId: input.conversationId,
      channelEventId: null,
      channelMessageId: null,
      direction: input.direction,
      actorType: input.direction === "outbound" ? "agent" : "user",
      actorId: null,
      contentType: "text",
      channelType: 1,
      text: input.text,
      isSelf: input.direction === "outbound",
      processingState: "not_applicable",
      sendState: input.sendState,
      replyBatchId: input.replyBatchId ?? null,
      replySequence: input.replySequence ?? null,
      sendUpdatedAt: input.sendUpdatedAt ?? null,
      idempotencyKey: messageId,
      occurredAt: at,
      createdAt: at,
      traceId: "held-visibility-test",
    });
  }

  it("held 分段进入提示块，>24h 的不注入", async () => {
    const conversationId = await createConversation("hint");
    await insertMessage({
      conversationId,
      tag: "held-recent",
      direction: "outbound",
      sendState: "held",
      text: "这个价格可以给您申请九折",
      replyBatchId: `agent-reply:turn:held-vis-${suffix}`,
      replySequence: 2,
      sendUpdatedAt: new Date(),
    });
    await insertMessage({
      conversationId,
      tag: "held-stale",
      direction: "outbound",
      sendState: "held",
      text: "两天前被扣留的旧分段",
      replyBatchId: `agent-reply:turn:held-vis-old-${suffix}`,
      replySequence: 1,
      sendUpdatedAt: new Date(Date.now() - 48 * 60 * 60_000),
    });
    await insertMessage({
      conversationId,
      tag: "inbound",
      direction: "inbound",
      sendState: null,
      text: "等等，能便宜点吗",
    });

    const context = await buildAgentContext(postgres!.db, conversationId);
    expect(context.prompt).toContain("已准备但未送达的回复分段");
    expect(context.prompt).toContain("这个价格可以给您申请九折");
    expect(context.prompt).not.toContain("两天前被扣留的旧分段");
  });

  it("窗口内未送达的出站消息带标注，已送达与入站无标注", async () => {
    const conversationId = await createConversation("annotate");
    await insertMessage({
      conversationId,
      tag: "out-pending",
      direction: "outbound",
      sendState: "pending",
      text: "还在排队的第一段",
      replyBatchId: `agent-reply:turn:held-vis-ann-${suffix}`,
      replySequence: 1,
    });
    await insertMessage({
      conversationId,
      tag: "out-confirmed",
      direction: "outbound",
      sendState: "confirmed",
      text: "已经发出去的第二段",
      replyBatchId: `agent-reply:turn:held-vis-ann-${suffix}`,
      replySequence: 2,
      sendUpdatedAt: new Date(),
    });
    await insertMessage({
      conversationId,
      tag: "out-hold",
      direction: "outbound",
      sendState: "held",
      text: "被扣留的第三段",
      replyBatchId: `agent-reply:turn:held-vis-ann-${suffix}`,
      replySequence: 3,
      sendUpdatedAt: new Date(),
    });
    await insertMessage({
      conversationId,
      tag: "in-plain",
      direction: "inbound",
      sendState: null,
      text: "客户的一句话",
    });

    const context = await buildAgentContext(postgres!.db, conversationId);
    const historyText = JSON.stringify(context.history);
    expect(historyText).toContain("还在排队的第一段（未送达）");
    expect(historyText).toContain("被扣留的第三段（未送达）");
    expect(historyText).toContain("已经发出去的第二段");
    expect(historyText).not.toContain("已经发出去的第二段（未送达）");
    expect(historyText).not.toContain("客户的一句话（未送达）");
  });

  it("已送达的出站分段进入「已发出的操作指令」清单：去重、排除未送达与寒暄", async () => {
    const conversationId = await createConversation("sent-list");
    const cases: ReadonlyArray<readonly [string, string, string | null]> = [
      ["sent-1", "灯亮就换个USB口重插。", "confirmed"],
      // 归一化后与上一条相同 → 清单里只应出现一次
      ["sent-2", " 灯亮就换个USB口重插。 ", "observed"],
      ["sent-3", "插好再开一次软件，看还报不报2272。", "confirmed"],
      ["sent-short", "好的。", "confirmed"],
      ["sent-pending", "还没发出去的一段话。", "pending"],
      ["sent-held", "被扣留的一段话。", "held"],
    ];
    for (const [tag, text, sendState] of cases) {
      await insertMessage({
        conversationId,
        tag,
        direction: "outbound",
        sendState,
        text,
        replyBatchId: `agent-reply:turn:sent-list-${suffix}`,
        replySequence: 1,
        sendUpdatedAt: new Date(),
      });
    }

    const context = await buildAgentContext(postgres!.db, conversationId);
    const marker = "本会话已发出的操作指令（近 24h 已送达，同一句只列一次）：";
    const start = context.prompt.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const tail = context.prompt.slice(start + marker.length);
    const listed = JSON.parse(
      tail.slice(0, tail.indexOf("。除非客户反馈")),
    ) as string[];
    // 逐字重复段去重后只列一次；未送达（pending/held）与寒暄不入清单
    expect([...listed].sort()).toEqual(
      [
        ...["灯亮就换个USB口重插。", "插好再开一次软件，看还报不报2272。"],
      ].sort(),
    );
  });
});

/**
 * Agent 上下文构建模块
 *
 * 为 LLM 调用组装完整的上下文信息：
 * - 最近 20 条消息历史（含图片描述、语音转写）
 * - 本批次消息摘要
 * - 上一人工接管周期的受控上下文
 * - 已确认的长期记忆
 *
 * 注意：此模块只负责组装事实，不参与策略决策或模型调用。
 * 平台不注入任何 Solution 业务状态；Solution 的 ExecutionStrategy
 * 可以在此基础上自行扩展上下文。
 */

import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { recallMemories } from "../../memory/application/recall-memories.js";
import { latestHumanCycleAgentContext } from "../../handoff/application/mobile-handoff-service.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";

/**
 * 构建 Agent 上下文
 * @param chatType 会话类型：private（私聊）或 group（群聊）
 * @returns history: 消息历史（user/assistant 格式）， prompt: 包含状态和记忆的提示文本
 */
export async function buildAgentContext(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
  chatType: "private" | "group" = "private",
): Promise<{
  history: { role: "user" | "assistant"; content: string }[];
  prompt: string;
}> {
  // 查询最近 20 条消息（按时间倒序获取后反转为正序）
  const history = await db
    .select({
      direction: schema.messages.direction,
      text: schema.messages.text,
      contentType: schema.messages.contentType,
      mediaDescription: schema.mediaAssets.description,
      actorId: schema.messages.actorId,
    })
    .from(schema.messages)
    .leftJoin(
      schema.mediaAssets,
      eq(schema.mediaAssets.messageId, schema.messages.messageId),
    )
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(desc(schema.messages.occurredAt))
    .limit(20);
  history.reverse();
  // 群聊：把入站消息的发送者 wxid 解析成可读昵称（同账号联系人资料，
  // 群成员本身在联系人同步范围内），让模型区分群里谁在问。
  const senderNames = new Map<string, string>();
  if (chatType === "group") {
    const memberRows = await db
      .select({
        channelContactId: schema.contactProfiles.channelContactId,
        channelDisplayName: schema.contactProfiles.channelDisplayName,
        channelNickname: schema.contactProfiles.channelNickname,
        channelRemark: schema.contactProfiles.channelRemark,
        sharedAlias: schema.contactProfiles.sharedAlias,
      })
      .from(schema.contactProfiles)
      .where(eq(schema.contactProfiles.channelAccount, "default"));
    for (const row of memberRows) {
      const resolved =
        row.sharedAlias?.trim() ||
        row.channelDisplayName?.trim() ||
        row.channelNickname?.trim() ||
        "";
      if (resolved) senderNames.set(row.channelContactId, resolved);
    }
  }
  const senderOf = (message: (typeof history)[number]): string | null =>
    chatType === "group" &&
    message.direction === "inbound" &&
    message.actorId
      ? (senderNames.get(message.actorId) ?? `wx…${message.actorId.slice(-6)}`)
      : null;
  type HistoryRow = (typeof history)[number];
  /**
   * 多模态消息统一渲染为文本：
   * - 图片有视觉描述 → "图片观察：{描述}"；无描述 → 诚实占位（禁止编造）
   * - 语音优先媒体转写、其次消息内文本；都没有 → 诚实占位
   * - 纯文本原样返回
   */
  const messageText = (message: HistoryRow): string => {
    switch (message.contentType) {
      case "image":
        return message.mediaDescription
          ? `图片观察：${message.mediaDescription}`
          : "[对方发送了一张图片，当前无法查看内容]";
      case "voice":
        if (message.mediaDescription) {
          return `语音转写：${message.mediaDescription}`;
        }
        return message.text
          ? `语音转写：${message.text}`
          : "[对方发来一条语音，转写不可用]";
      default:
        return message.text;
    }
  };
  // 召回最近 12 条已确认的长期记忆（memory_enabled OFF 时不 recall）
  const runtime = await readRuntimeSettings(db);
  const memories = !runtime.memoryEnabled
    ? []
    : await recallMemories(db, conversationId, 12);
  const previousHumanCycle = await latestHumanCycleAgentContext(
    db,
    conversationId,
  );
  // 取最近 3 条入站消息用于批次摘要
  const latestInbound = history
    .filter((message) => message.direction === "inbound")
    .slice(-3);
  const batchSummary = {
    inbound_messages: latestInbound.map((message) => {
      const sender = senderOf(message);
      const text = messageText(message);
      // 群聊批次摘要带发送者名，模型可区分群里谁在问
      return sender ? `${sender}：${text}` : text;
    }),
  };
  const now = new Date();
  const nowText = formatCurrentTime(now);
  const chatTypeHint =
    chatType === "group"
      ? "\n当前会话类型：群聊（回复应简洁，避免包含私人信息或针对特定联系人的个性化内容）"
      : "\n当前会话类型：私聊";
  return {
    history: history.map((message) => {
      const sender = senderOf(message);
      // 群聊历史入站消息带发送者前缀；私聊与出站保持原样
      const content = sender
        ? `${sender}：${messageText(message)}`
        : messageText(message);
      return {
        role:
          message.direction === "inbound"
            ? ("user" as const)
            : ("assistant" as const),
        content,
      };
    }),
    prompt: `${chatTypeHint}\n\n当前时间：${nowText}\n\n上一人工接管周期结果（受控上下文；不含内部转交链）：${JSON.stringify(
      previousHumanCycle,
    )}\n\n本批次消息摘要（由程序生成，不重复询问其中已确认的信息）：${JSON.stringify(
      batchSummary,
    )}\n\n已确认长期记忆（仅在相关时使用，不向对方暴露内部记录）：${JSON.stringify(
      memories.map((memory) => ({
        key: `${memory.kind}.${memory.memoryKey}`,
        value: memory.content,
        source: "confirmed_memory",
      })),
    )}`,
  };
}

const WEEKDAYS = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
] as const;

function formatCurrentTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const weekday: string = WEEKDAYS[date.getDay()] ?? "";
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${weekday} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

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
    inbound_messages: latestInbound.map((message) =>
      message.contentType === "image" && message.mediaDescription
        ? `图片观察：${message.mediaDescription}`
        : message.contentType === "image"
          ? "[对方发送了一张图片，当前无法查看内容]"
          : message.contentType === "voice" && message.mediaDescription
            ? `语音转写：${message.mediaDescription}`
            : // 通道侧已提供转写文本（如微信自动转文字）时直接用文本理解
              message.contentType === "voice" && message.text
              ? `语音转写：${message.text}`
              : message.contentType === "voice"
                ? "[对方发来一条语音，转写不可用]"
                : message.text,
    ),
  };
  const now = new Date();
  const nowText = formatCurrentTime(now);
  const chatTypeHint =
    chatType === "group"
      ? "\n当前会话类型：群聊（回复应简洁，避免包含私人信息或针对特定联系人的个性化内容）"
      : "\n当前会话类型：私聊";
  return {
    history: history.map((message) => ({
      role: message.direction === "inbound" ? "user" : "assistant",
      content:
        message.contentType === "image" && message.mediaDescription
          ? `[图片观察：${message.mediaDescription}]`
          : message.contentType === "image"
            ? "[对方发送了一张图片，当前无法查看内容]"
            : message.contentType === "voice" && message.mediaDescription
              ? `[语音转写：${message.mediaDescription}]`
              : message.contentType === "voice" && message.text
                ? `[语音转写：${message.text}]`
                : message.contentType === "voice"
                  ? "[对方发来一条语音，转写不可用]"
                  : message.text,
    })),
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

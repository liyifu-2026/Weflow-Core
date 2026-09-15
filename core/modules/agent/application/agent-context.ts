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

import { and, asc, desc, eq, gt, inArray, like, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { FileStorage } from "../../../infrastructure/file_storage/types.js";
import type { TextModelContent } from "../../model/contracts/text-generation-request.js";
import { recallMemories } from "../../memory/application/recall-memories.js";
import { latestHumanCycleAgentContext } from "../../handoff/application/mobile-handoff-service.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";
import { mediaAwareMessageText } from "./media-context.js";
import { imageToContentPart } from "./image-content.js";
import {
  readConversationFacts,
  type ConversationFactCard,
} from "./conversation-facts.js";
import { buildOlderRoundSummaries } from "./round-window.js";
import type { RoundSummaryLabels } from "./behavior-settings.js";
import { maskedSenderLabel } from "../../conversations/application/sender-display.js";
import {
  DELIVERED_SEND_STATES,
  isDeliveredSendState,
  SEND_STATE,
} from "../../conversations/application/send-states.js";
import { normalizeReplyText } from "./reply-text.js";

/** 已发指令清单：原文扫描上限（去重与截断在此之后进行） */
const SENT_INSTRUCTION_SCAN_LIMIT = 40;
/** 已发指令清单：注入条数上限 */
const SENT_INSTRUCTION_LIMIT = 12;
/** 已发指令清单：短于该长度视为寒暄（"好的。""在的。"）不入清单 */
const MIN_INSTRUCTION_LENGTH = 6;

/**
 * 已发指令清单：归一化去重（保序，输入为最近优先），滤掉寒暄短句，封顶
 * SENT_INSTRUCTION_LIMIT 条。
 *
 * 「换个说法再说一遍」的重复不触发任何去重，只有把已发内容显式摆出来，
 * 模型才判得出「这步已经说过了」。原文窗口只有 20 条，长会话里早期步骤
 * 会滑出窗口，故此处单独成清单。
 */
export function dedupeSentInstructions(texts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const text of texts) {
    const normalized = normalizeReplyText(text);
    if (normalized.length < MIN_INSTRUCTION_LENGTH) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(text.trim());
    if (result.length >= SENT_INSTRUCTION_LIMIT) break;
  }
  return result;
}

/**
 * 群聊噪声判定：剥掉 WeChat 表情占位（[呲牙] 等）、标点、符号、空白与
 * emoji 后不剩任何实义字符 → 视为噪声。摄取闸门（线程内免 @ 消息的
 * 0 成本前挡）与上下文装配（窗口分拣 + 摘要行）共用。
 */
export function isGroupNoiseText(text: string): boolean {
  const stripped = (text ?? "")
    .replace(/\[[^\][\n]{1,12}\]/g, "")
    .replace(/[\p{P}\p{S}\p{Z}\s]/gu, "");
  return stripped.length === 0;
}

/**
 * 构建 Agent 上下文
 * @param chatType 会话类型：private（私聊）或 group（群聊）
 * @returns history: 消息历史（user/assistant 格式）， prompt: 包含状态和记忆的提示文本
 */
export type BuildAgentContextOptions = {
  trigger?: "message" | "wake";
  /**
   * 轮窗摘要角色标签（ADR-0011）：随行为参数从组合根透传；
   * 缺省引擎中立 customer/assistant。
   */
  roundLabels?: RoundSummaryLabels;
  /**
   * Phase 4 视觉直读：仅当注入（agent-worker 提供 storage + 开关开启）
   * 时才会把「最新入站图片」作为 image_url 段喂给主模型；缺省不装配，
   * 图片维持既有文本渲染（占位/描述），零行为变化。
   */
  image?: {
    storage: FileStorage;
    readImage?: typeof imageToContentPart;
  };
};

export async function buildAgentContext(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
  chatType: "private" | "group" = "private",
  options: BuildAgentContextOptions = {},
): Promise<{
  history: { role: "user" | "assistant"; content: TextModelContent }[];
  prompt: string;
}> {
  // 查询最近 20 条消息（按时间倒序获取后反转为正序）
  // 图片直读需要关联原图（originalImageFileId）与存档（originalFileId）
  // 两份 storedFiles，取 mime/存储键用于后续读字节转 data URI。
  const originalImage = alias(schema.storedFiles, "img_original");
  const fallback = alias(schema.storedFiles, "img_fallback");
  let history = await db
    .select({
      messageId: schema.messages.messageId,
      direction: schema.messages.direction,
      text: schema.messages.text,
      contentType: schema.messages.contentType,
      occurredAt: schema.messages.occurredAt,
      mediaDescription: schema.mediaAssets.description,
      originalImageFileId: schema.mediaAssets.originalImageFileId,
      originalFileId: schema.mediaAssets.originalFileId,
      originalFileMimeType: originalImage.mimeType,
      originalFileStorageKey: originalImage.storageKey,
      originalFileSize: originalImage.size,
      fallbackMimeType: fallback.mimeType,
      fallbackStorageKey: fallback.storageKey,
      fallbackSize: fallback.size,
      actorId: schema.messages.actorId,
      sendState: schema.messages.sendState,
    })
    .from(schema.messages)
    .leftJoin(
      schema.mediaAssets,
      eq(schema.mediaAssets.messageId, schema.messages.messageId),
    )
    .leftJoin(
      originalImage,
      eq(originalImage.fileId, schema.mediaAssets.originalImageFileId),
    )
    .leftJoin(fallback, eq(fallback.fileId, schema.mediaAssets.originalFileId))
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
    chatType === "group" && message.direction === "inbound" && message.actorId
      ? (senderNames.get(message.actorId) ?? maskedSenderLabel(message.actorId))
      : null;
  type HistoryRow = (typeof history)[number];
  // 群聊窗口裁剪：纯噪声消息（表情包/纯标点）移出模型窗口，按发送者
  // 计数进摘要行——模型知道群里有节奏，但不拿噪声当对话主料。
  // 最新一条入站消息永不过滤（它是本轮的触发消息）。
  let groupNoiseDigest = "";
  if (chatType === "group") {
    const lastInboundIndex = history.findLastIndex(
      (message) => message.direction === "inbound",
    );
    const substantive: HistoryRow[] = [];
    const noiseBySender = new Map<string, number>();
    history.forEach((message, index) => {
      const isNoise =
        index !== lastInboundIndex &&
        message.direction === "inbound" &&
        message.contentType === "text" &&
        isGroupNoiseText(message.text ?? "");
      if (isNoise) {
        const name = senderOf(message) ?? "有人";
        noiseBySender.set(name, (noiseBySender.get(name) ?? 0) + 1);
        return;
      }
      substantive.push(message);
    });
    if (noiseBySender.size > 0) {
      const parts = [...noiseBySender.entries()]
        .map(([name, count]) => `${name} ×${count}`)
        .join("、");
      groupNoiseDigest = `\n\n近段群内另有（短水消息，已省略原文）：${parts}`;
    }
    history = substantive;
  }
  /**
   * 多模态消息统一渲染为文本：
   * - 图片有描述（caption 或模型自写 media_notes）→ 图片观察
   * - 无描述 → 诚实占位（禁止编造；不存在可用的看图工具，
   *   不再注入 fetch_url 可看图信号——那是必然失败的工具死路）
   * - 语音转写语义与纯文本透传保持既有行为
   */
  const messageText = (message: HistoryRow): string =>
    mediaAwareMessageText({
      contentType: message.contentType,
      text: message.text,
      mediaDescription: message.mediaDescription,
      messageId: message.messageId,
    });
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
  // 定时发送可见性（SCHEDULED-SEND-PLAN 决策 #5）：待发与近 24h 内被
  // 新事件作废的定时消息进入上下文，模型自行决定补发/改期/放弃。
  const scheduledSends = await db
    .select({
      content: schema.scheduledSends.content,
      status: schema.scheduledSends.status,
      sendAt: schema.scheduledSends.sendAt,
      cancelReason: schema.scheduledSends.cancelReason,
      updatedAt: schema.scheduledSends.updatedAt,
    })
    .from(schema.scheduledSends)
    .where(
      and(
        eq(schema.scheduledSends.conversationId, conversationId),
        sql`(${schema.scheduledSends.status} in ('pending','frozen') or (${schema.scheduledSends.status} = 'cancelled' and ${schema.scheduledSends.cancelReason} = 'new_inbound' and ${schema.scheduledSends.updatedAt} > now() - interval '24 hours'))`,
      ),
    )
    .orderBy(desc(schema.scheduledSends.updatedAt))
    .limit(5);
  const scheduledSendHint =
    scheduledSends.length > 0
      ? `\n\n定时消息（程序维护的既定承诺；pending 的到点会自动直发，cancelled(new_inbound) 的已因用户新消息作废——若仍有必要请重新安排或在回复中处理）：${JSON.stringify(
          scheduledSends.map((item) => ({
            content: item.content,
            status: item.status,
            sendAt: item.sendAt.toISOString(),
            ...(item.cancelReason ? { cancelReason: item.cancelReason } : {}),
          })),
        )}`
      : "";
  // 被扣留的 agent 回复分段（发送期插话闸门 / kill switch 置 held）：
  // 「已准备未送达」的悬而未决项，新决策可改写重发、原样补发或放弃——
  // 与 cancelled 定时消息同一可见性模式（24h 内）。咨询性上下文，失败
  // 静默降级为零注入。
  const heldSegments = await db
    .select({
      text: schema.messages.text,
      replySequence: schema.messages.replySequence,
      sendUpdatedAt: schema.messages.sendUpdatedAt,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.sendState, SEND_STATE.held),
        like(schema.messages.replyBatchId, "agent-reply:%"),
        gt(
          schema.messages.sendUpdatedAt,
          new Date(now.getTime() - 24 * 60 * 60_000),
        ),
      ),
    )
    .orderBy(
      asc(schema.messages.replyBatchId),
      asc(schema.messages.replySequence),
    )
    .limit(8)
    .catch(() => []);
  const heldHint =
    heldSegments.length > 0
      ? `\n\n已准备但未送达的回复分段（可能因对方插话被程序扣留；由你决定改写后重新发出、原样补发或放弃，注意不要与上文已送达内容重复）：${JSON.stringify(
          heldSegments.map((segment) => segment.text),
        )}`
      : "";
  // 已发出的操作指令清单（近 24h 内已送达的 agent 出站分段，归一化去重）：
  // 逐段发送的回复在窗口里是散的，且「换个说法再说一遍」不触发去重——
  // 把已发内容显式列出来，重复才判得出、才拦得住。咨询性上下文，读取
  // 失败静默降级为零注入。
  const sentInstructionRows = await db
    .select({ text: schema.messages.text })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.direction, "outbound"),
        eq(schema.messages.actorType, "agent"),
        inArray(schema.messages.sendState, [...DELIVERED_SEND_STATES]),
        gt(
          schema.messages.occurredAt,
          new Date(now.getTime() - 24 * 60 * 60_000),
        ),
      ),
    )
    .orderBy(desc(schema.messages.occurredAt), desc(schema.messages.messageId))
    .limit(SENT_INSTRUCTION_SCAN_LIMIT)
    .catch(() => []);
  const sentInstructions = dedupeSentInstructions(
    sentInstructionRows.map((row) => row.text),
  );
  const sentInstructionHint =
    sentInstructions.length > 0
      ? `\n\n本会话已发出的操作指令（近 24h 已送达，同一句只列一次）：${JSON.stringify(
          sentInstructions,
        )}。除非客户反馈该步骤无效或未解决，不要重复给出这些指令；确需重发时必须说明与上次的差异。`
      : "";
  const chatTypeHint =
    chatType === "group"
      ? "\n当前会话类型：群聊（回复应简洁，避免包含私人信息或针对特定联系人的个性化内容）"
      : "\n当前会话类型：私聊";
  // 唤醒轮标记：wait 超时触发而非新消息触发——上一轮回复后对方一直
  // 没说话，模型据此决定轻追问 / 继续等待 / 收尾，而不是重复答疑。
  const wakeHint =
    options.trigger === "wake"
      ? "\n本Turn由等待超时唤醒：自你上次回复后对方未再发送任何消息。不要重复已给出的内容。"
      : "";
  // Phase 4 视觉直读：仅当显式注入 storage 且视觉开关开启时，才把
  // 「最新一条入站图片」装配为 image_url 段（带文本段说明）。历史的
  // 图片/其他消息保持既有渲染；读取失败回落文本占位，不阻断轮次。
  // 私聊批：会话事实卡 + 更早回合摘要（仅私聊装配；群聊宇宙有自己的
  // 窗口裁剪）。两者均为咨询性上下文，读取失败静默降级为零注入。
  let factCardHint = "";
  let olderRoundHint = "";
  if (chatType === "private") {
    const [factCard, olderRounds] = await Promise.all([
      readConversationFacts(db, conversationId).catch(
        (): ConversationFactCard | null => null,
      ),
      buildOlderRoundSummaries(db, {
        conversationId,
        beforeOccurrence: history[0]?.occurredAt ?? new Date(),
        ...(options.roundLabels ? { labels: options.roundLabels } : {}),
      }).catch((): string[] => []),
    ]);
    if (factCard) {
      factCardHint = `\n\n【会话事实卡】（你上次更新的本会话状态，跨回合持久；facts_card 字段可随决策更新）${JSON.stringify(factCard)}`;
    }
    if (olderRounds.length > 0) {
      olderRoundHint = `\n\n更早回合摘要（由旧到新；细节以事实卡与上文原文为准）：\n${olderRounds
        .map((line) => `- ${line}`)
        .join("\n")}`;
    }
  }
  const imageCfg = options.image;
  const latestInboundImage =
    imageCfg?.storage && runtime.visionEnabled
      ? [...history]
          .reverse()
          .find(
            (message) =>
              message.direction === "inbound" &&
              message.contentType === "image" &&
              (message.originalFileId || message.originalImageFileId),
          )
      : undefined;
  const readImage = imageCfg?.readImage ?? imageToContentPart;
  const latestImagePart =
    latestInboundImage && imageCfg?.storage
      ? await readImage(
          imageCfg.storage,
          latestInboundImage.originalImageFileId ?? null,
          latestInboundImage.originalFileId ?? null,
          latestInboundImage.originalFileMimeType ??
            latestInboundImage.fallbackMimeType ??
            null,
        )
      : null;

  return {
    history: collapseConsecutiveAssistantMessages(
      history.map((message) => {
        const sender = senderOf(message);
        // 出站消息的送达事实标注：排队/发送中/被扣留/失败的分段在窗口
        // 里不得冒充「已说出口的话」——否则新决策会引用对方还没收到的
        // 内容（sendState 洞修复，与发送期插话闸门配套）。
        const deliveryNote =
          message.direction === "outbound" &&
          message.sendState !== null &&
          !isDeliveredSendState(message.sendState)
            ? "（未送达）"
            : "";
        const text = `${sender ? `${sender}：` : ""}${messageText(message)}${deliveryNote}`;
        const isLatestImage =
          latestInboundImage !== undefined &&
          latestInboundImage.messageId === message.messageId;
        const imagePart =
          isLatestImage && latestImagePart
            ? {
                type: "image_url" as const,
                image_url: { url: latestImagePart.image_url.url },
              }
            : null;
        const content: TextModelContent = imagePart
          ? [{ type: "text", text }, imagePart]
          : text;
        return {
          role:
            message.direction === "inbound"
              ? ("user" as const)
              : ("assistant" as const),
          content,
        };
      }),
    ),
    prompt: `${chatTypeHint}${wakeHint}${factCardHint}${groupNoiseDigest}\n\n当前时间：${nowText}\n\n上一人工接管周期结果（受控上下文；不含内部转交链）：${JSON.stringify(
      previousHumanCycle,
    )}\n\n本批次消息摘要（由程序生成，不重复询问其中已确认的信息）：${JSON.stringify(
      batchSummary,
    )}${olderRoundHint}${scheduledSendHint}${heldHint}${sentInstructionHint}\n\n已确认长期记忆（仅在相关时使用，不向对方暴露内部记录）：${JSON.stringify(
      memories.map((memory) => ({
        key: `${memory.kind}.${memory.memoryKey}`,
        value: memory.content,
        source: "confirmed_memory",
      })),
    )}`,
  };
}

/**
 * 折叠连续 assistant 消息：退化尾部（连续多条 agent 回复，如复读/拆条
 * 连发）会让多模态决策模型输出空白或逐字复读（2026-09-07 可可猫群实测：
 * 窗口尾部 3 条近似重复的 agent 回复 → vision-exp 连续 6 次输出纯空白
 * → retry_exhausted 失败转人工）。折叠后恢复"一问一答"结构；私聊群聊
 * 同样受益。仅合并文本段——assistant 侧不携带图片段，多模态数组不参与
 * 合并（保持原样）。
 */
export function collapseConsecutiveAssistantMessages(
  history: {
    role: "user" | "assistant";
    content: TextModelContent;
  }[],
): {
  role: "user" | "assistant";
  content: TextModelContent;
}[] {
  const collapsed: {
    role: "user" | "assistant";
    content: TextModelContent;
  }[] = [];
  for (const message of history) {
    const previous = collapsed[collapsed.length - 1];
    const mergeable =
      previous?.role === "assistant" &&
      message.role === "assistant" &&
      typeof previous.content === "string" &&
      typeof message.content === "string";
    if (mergeable && previous) {
      previous.content = `${previous.content as string}\n${message.content as string}`;
      continue;
    }
    collapsed.push({ role: message.role, content: message.content });
  }
  return collapsed;
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

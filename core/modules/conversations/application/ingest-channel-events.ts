/**
 * Channel 事件摄取模块
 * 从 Channel Host 拉取标准化事件并写入 Core 数据库。
 * 处理消息入库、联系人/会话创建、媒体资源关联、
 * Agent Turn 触发和人工接管通知等逻辑。
 */

import { and, eq, ne, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { createLogger } from "../../../infrastructure/observability/logger.js";
import type { ChannelEvent } from "../../channel/contracts/channel-event-source.js";
import { contactIdForChannel } from "../../contacts/application/contact-profile-service.js";
import { scheduleMemoryCaptureInTransaction } from "../../memory/application/schedule-memory-capture.js";
import { enqueueAssigneeInboundNotification } from "../../notifications/application/notification-outbox.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";
import { createHandoff } from "../../handoff/application/handoff-service.js";
import { conversationEvents } from "../../../infrastructure/events/conversation-events.js";
import { resolveExecutionProfileForAdmission } from "../../agent/application/execution-profile-service.js";
import {
  DEFAULT_GROUP_CHAT_POLICY,
  shouldRespondToGroupMessage,
} from "../../agent/application/group-chat-policy.js";

const CHANNEL_SOURCE = "channel-host";
/** 平台通道标识：用于会话/联系人/消息 ID 前缀与 channel 列（通道无关） */
const CHANNEL_KIND = "channel";

const DEFAULT_LOGGER = createLogger(
  { logLevel: "silent" },
  "ingest-channel-events",
);

export async function currentChannelCursor(
  db: NodePgDatabase<typeof schema>,
  source = CHANNEL_SOURCE,
): Promise<number> {
  const rows = await db
    .select({ cursor: schema.channelCursors.cursor })
    .from(schema.channelCursors)
    .where(sql`${schema.channelCursors.source} = ${source}`)
    .limit(1);
  return rows[0]?.cursor ?? 0;
}

/**
 * 批量摄取 Channel Host 事件。
 * 每个事件在事务中处理：确保联系人/会话存在、插入消息、
 * 处理图片媒体关联、触发内存捕获、通知人工坐席、
 * 以及为符合条件的入站消息创建 Agent Turn。
 */
/** Ingest normalized text events from the real Channel Host boundary. */
export async function ingestChannelEvents(
  db: NodePgDatabase<typeof schema>,
  events: ChannelEvent[],
  nextCursor: string,
  logger: Logger = DEFAULT_LOGGER,
): Promise<void> {
  const numericCursor = Number(nextCursor);
  if (!Number.isSafeInteger(numericCursor) || numericCursor < 0) {
    throw new Error(`channel_cursor_invalid:${nextCursor}`);
  }
  await ingestNormalizedEvents(
    db,
    events.map(toNormalizedChannelEvent),
    numericCursor,
    CHANNEL_SOURCE,
    logger,
  );
}

type NormalizedChannelEvent = {
  eventId: string;
  conversationId: string;
  /** 账号维度（ADR-0005）；缺省 "default" */
  account: string;
  channelMessageId: string;
  sourceLocalId: number | null;
  sourceMediaRef: string | null;
  senderId: string | null;
  type: number;
  kind: string;
  content: string;
  occurredAt: number;
  isSelf: boolean | null;
  /** 群聊被 @ 提及（ADR-0006） */
  mentioned: boolean | null;
  /** 入站引用原消息（ADR-0006） */
  replyToChannelMessageId: string | null;
  /** 历史回溯事件（空库 Backfill）：入库但跳过一切 AI/通知副作用 */
  historical: boolean;
};

async function ingestNormalizedEvents(
  db: NodePgDatabase<typeof schema>,
  events: NormalizedChannelEvent[],
  nextCursor: number,
  source: string,
  logger: Logger,
): Promise<void> {
  const deferredGlobalPause: { conversationId: string; messageId: string }[] =
    [];
  await db.transaction(async (transaction) => {
    // 全局 Agent 开关：安全关键，fresh 读（不经过缓存）
    const settings = await readRuntimeSettings(transaction, logger, {
      fresh: true,
    });
    for (const event of events) {
      const account = normalizeAccount(event.account);
      // default 账号保持旧格式 ID（channel:<ref>），兼容存量数据不回写；
      // 非 default 账号带 account 段（channel:<account>:<ref>）实现多账号隔离。
      let conversationId =
        account === "default"
          ? `${CHANNEL_KIND}:${event.conversationId}`
          : `${CHANNEL_KIND}:${account}:${event.conversationId}`;
      let contactId = contactIdForChannel(
        CHANNEL_KIND,
        event.conversationId,
        account,
      );
      // 防护（ADR-0005 数据一致性）：事件缺账号（回落 default）时，若该客户
      // 已在某个真实账号下存在会话，则路由进既有账号会话，避免再造 default 孤儿
      // 会话、拆散该客户历史（历史事件曾因 host 未注入 WECHAT_ACCOUNT 而缺账号）。
      if (account === "default") {
        const existing = await transaction
          .select({
            conversationId: schema.conversations.conversationId,
            contactId: schema.conversations.contactId,
          })
          .from(schema.conversations)
          .where(
            and(
              eq(schema.conversations.channel, CHANNEL_KIND),
              eq(schema.conversations.channelConversationId, event.conversationId),
              ne(schema.conversations.channelAccount, "default"),
            ),
          )
          .limit(1);
        if (existing[0]) {
          conversationId = existing[0].conversationId;
          contactId = existing[0].contactId;
        }
      }
      await transaction
        .insert(schema.contactProfiles)
        .values({
          contactId,
          channel: CHANNEL_KIND,
          channelAccount: account,
          channelContactId: event.conversationId,
          // 显示名保护（§4.2 污染修复）：senderId 是 wxid 且可能恰为自账号
          // （历史 bug：自消息事件把客户显示名覆盖成自账号 wxid）。
          // 自消息（isSelf）绝不写显示名；真实昵称/备注由
          // sync-channel-contact-profiles 以微信资料为准写入。
          channelDisplayName: event.isSelf ? undefined : (event.senderId ?? undefined),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.contactProfiles.channel,
            schema.contactProfiles.channelAccount,
            schema.contactProfiles.channelContactId,
          ],
          set: {
            // 冲突时只用非空 senderId 补空显示名，绝不用 wxid 覆盖已有昵称
            channelDisplayName: sql`COALESCE(NULLIF(${schema.contactProfiles.channelDisplayName}, ''), EXCLUDED.channel_display_name)`,
            updatedAt: new Date(),
          },
        });
      await transaction
        .insert(schema.conversations)
        .values({
          conversationId,
          contactId,
          channel: CHANNEL_KIND,
          channelAccount: account,
          channelConversationId: event.conversationId,
        })
        .onConflictDoNothing();

      const direction =
        event.isSelf === true
          ? "outbound"
          : event.isSelf === false
            ? "inbound"
            : "unknown";
      const insertedMessages = await transaction
        .insert(schema.messages)
        .values({
          messageId: `${CHANNEL_KIND}:${event.eventId}`,
          conversationId,
          channelEventId: event.eventId,
          channelMessageId: event.channelMessageId,
          direction,
          actorType:
            direction === "outbound"
              ? "system"
              : direction === "inbound"
                ? `${CHANNEL_KIND}_contact`
                : "system",
          actorId: event.senderId,
          contentType: event.kind,
          channelType: event.type,
          text: event.content,
          isSelf: event.isSelf,
          processingState:
            direction === "inbound" ? "received" : "not_applicable",
          sendState: direction === "outbound" ? "observed" : null,
          replyToChannelMessageId: event.replyToChannelMessageId ?? null,
          mentionContactRefs: event.mentioned
            ? [event.senderId ?? "unknown"]
            : [],
          idempotencyKey: event.eventId,
          occurredAt: new Date(event.occurredAt * 1000),
          traceId: `${source}-event:${event.eventId}`,
        })
        .onConflictDoNothing()
        .returning({ messageId: schema.messages.messageId });

      const handoff = await transaction
        .select({
          agentPaused: schema.handoffStates.agentPaused,
          status: schema.handoffStates.status,
          assignedUserId: schema.handoffStates.assignedUserId,
        })
        .from(schema.handoffStates)
        .where(eq(schema.handoffStates.conversationId, conversationId))
        .limit(1);
      const agentPaused = handoff[0]?.agentPaused ?? false;
      const contactProfiles = await transaction
        .select({
          agentEnabled: schema.contactProfiles.agentEnabled,
          blocked: schema.contactProfiles.blocked,
        })
        .from(schema.contactProfiles)
        .where(eq(schema.contactProfiles.contactId, contactId))
        .limit(1);
      // 黑名单联系人不触发任何 AI / 通知副作用（消息照常入库展示）
      const blocked = contactProfiles[0]?.blocked ?? false;
      const agentEnabled =
        (contactProfiles[0]?.agentEnabled ?? true) && !blocked;
      const insertedMessageId = insertedMessages[0]?.messageId;
      // 空库 Backfill（historical=true）：历史消息只入库展示，绝不触发
      // 任何 AI/通知副作用——实时事件链路的四个副作用点（UI 事件流、
      // 人工通知、媒体转写排队、记忆捕获）在此全部跳过。
      if (insertedMessageId && !event.historical) {
        conversationEvents.publish({
          type: direction === "inbound" ? "customer_message" : "agent_message",
          conversationId,
          messageId: insertedMessageId,
          occurredAt: new Date().toISOString(),
        });
        if (
          direction === "inbound" &&
          !blocked &&
          handoff[0]?.status === "in_progress" &&
          handoff[0].assignedUserId
        ) {
          await enqueueAssigneeInboundNotification(
            transaction,
            conversationId,
            handoff[0].assignedUserId,
            new Date(event.occurredAt * 1000),
          );
        }
        if (
          direction === "inbound" &&
          (event.kind === "image" ||
            event.kind === "video" ||
            event.kind === "file" ||
            // 语音仅在无转写文本时建资产走 ASR 备选路径；
            // 有转写的语音以正文文本直达 Agent/前端，无需媒体流水线
            (event.kind === "voice" && event.content.trim() === ""))
        ) {
          await transaction
            .insert(schema.mediaAssets)
            .values({
              mediaId: mediaIdForEvent(event.eventId),
              messageId: insertedMessageId,
              conversationId,
              sourceConversationId: event.conversationId,
              sourceLocalId: event.sourceLocalId,
              sourceMediaRef: event.sourceMediaRef,
              kind: event.kind,
            })
            .onConflictDoNothing();
        }
        // 记忆捕获属于 AI 服务（提取调用模型）：非白名单（agentEnabled=false）
        // 客户只入库展示，不触发任何 AI 动作（无回复、无记忆提取、无昵称查询）。
        if (agentEnabled) {
          await scheduleMemoryCaptureInTransaction(transaction, {
            conversationId,
            contactId,
            watermarkMessageId: insertedMessageId,
          });
        }
      }
      if (
        direction === "inbound" &&
        event.kind !== "image" &&
        event.kind !== "pat" &&
        // 无转写文本的语音不立即建 Turn：等 ASR 成功（media ready）或失败降级
        !(event.kind === "voice" && event.content.trim() === "") &&
        insertedMessages.length === 1 &&
        // 历史回溯消息绝不触发 Agent Turn（空库 Backfill 安全边界）
        !event.historical &&
        !agentPaused &&
        agentEnabled &&
        settings.agentEnabled &&
        // 群聊响应策略（ADR-0006）：默认仅被 @ 时回复，避免群内刷屏
        shouldAcceptForAgentTurn(event)
      ) {
        const messageId = insertedMessageId;
        if (!messageId) {
          throw new Error("inserted inbound message did not return an id");
        }
        const admission =
          await resolveExecutionProfileForAdmission(transaction);
        if (!admission.allowed) {
          // Phase 7: no active Execution Profile -> no new Agent Turn.
          // The refusal is intentionally not persisted as a Turn.
          continue;
        }
        await transaction
          .insert(schema.agentTurns)
          .values({
            turnId: `turn:${messageId}`,
            triggerMessageId: messageId,
            conversationId,
            status: "queued",
            executionProfileId: admission.profile.profileId,
            traceId: `${source}-event:${event.eventId}`,
          })
          .onConflictDoNothing();
      }
      // 全局 Agent 关闭：消息照常入库，但任何客户消息不得无人处理——
      // 事务提交后幂等进入人工路径（事务内调 createHandoff 会因
      // 会话行尚未提交而返回 conversation_not_found，必须延迟到提交后）
      // 历史回溯消息不进入人工路径：backfill 不产生任何待办/通知。
      if (
        direction === "inbound" &&
        insertedMessageId &&
        !event.historical &&
        !agentPaused &&
        !settings.agentEnabled
      ) {
        deferredGlobalPause.push({
          conversationId,
          messageId: insertedMessageId,
        });
      }
    }

    await transaction
      .insert(schema.channelCursors)
      .values({
        source,
        cursor: nextCursor,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.channelCursors.source,
        set: {
          cursor: nextCursor,
          updatedAt: new Date(),
        },
      });
  });
  // 事务提交后再进入人工路径（此时会话行已可见）
  for (const item of deferredGlobalPause) {
    const result = await createHandoff(db, {
      conversationId: item.conversationId,
      actorUserId: "system",
      clientRequestId: `global-pause-${createHash("sha256")
        .update(item.messageId)
        .digest("hex")
        .slice(0, 22)}`,
      summary: "global_pause: agent disabled",
      sourceIp: "server2",
    });
    if (result.status !== "ok" && result.status !== "invalid_transition") {
      logger.warn(
        { status: result.status, conversationId: item.conversationId },
        "global pause handoff skipped",
      );
    }
  }
}

const IMAGE_LIKE_KINDS = new Set(["image", "emoji", "emotion"]);
/** 需要携带 mediaRef 的媒体类事件（视频/文件/语音与图片同等对待） */
const MEDIA_KINDS = new Set([...IMAGE_LIKE_KINDS, "file", "voice", "video"]);
/** 纯文本事件（不需要 mediaRef；emotion 已文本化为 [表情包]<含义>） */
const TEXT_LIKE_KINDS = new Set(["text", "pat"]);
/** Provider-neutral 通道类型映射（沿用源通道编号，业务层不解析） */
const FILE_CHANNEL_TYPE = 49;
const VOICE_CHANNEL_TYPE = 34;
const VIDEO_CHANNEL_TYPE = 43;

function toNormalizedChannelEvent(event: ChannelEvent): NormalizedChannelEvent {
  // pat 与文本化 emotion（[表情包]<含义>）按文本处理，无需 mediaRef；
  // 传统 emotion 带 mediaRef 时仍走图片链路（兼容旧 Host）。
  const isTextLike = TEXT_LIKE_KINDS.has(event.kind);
  const isEmotionWithRef =
    event.kind === "emotion" && Boolean(event.mediaRef);
  if (event.kind !== "text" && !MEDIA_KINDS.has(event.kind) && !isTextLike) {
    throw new Error(`channel_event_unsupported_kind:${event.kind}`);
  }
  if (
    MEDIA_KINDS.has(event.kind) &&
    !isTextLike &&
    !isEmotionWithRef &&
    !event.mediaRef
  ) {
    throw new Error(`channel_image_media_ref_required:${event.eventId}`);
  }
  const occurredAt = Date.parse(event.occurredAt ?? event.observedAt);
  if (!Number.isFinite(occurredAt)) {
    throw new Error(`channel_event_invalid_timestamp:${event.eventId}`);
  }
  const channelMessageId = event.channelMessageId ?? event.eventId;
  const imageLike = IMAGE_LIKE_KINDS.has(event.kind) && isEmotionWithRef;
  const fileLike = event.kind === "file";
  const videoLike = event.kind === "video";
  return {
    eventId: event.eventId,
    conversationId: event.conversationRef,
    account: normalizeAccount(event.account),
    channelMessageId,
    sourceLocalId: null,
    sourceMediaRef: event.mediaRef ?? null,
    senderId: event.senderRef ?? null,
    type: imageLike
      ? 3
      : videoLike
        ? VIDEO_CHANNEL_TYPE
        : fileLike
          ? FILE_CHANNEL_TYPE
          : event.kind === "voice"
            ? VOICE_CHANNEL_TYPE
            : 1,
    kind: imageLike ? "image" : event.kind,
    content: event.content,
    occurredAt: Math.floor(occurredAt / 1000),
    isSelf: event.isSelf,
    mentioned: event.mentioned ?? null,
    replyToChannelMessageId: event.replyToChannelMessageId ?? null,
    historical: event.historical === true,
  };
}

/** 归一化账号标识（ADR-0005）：空值回落 "default" */
export function normalizeAccount(account: string | null | undefined): string {
  const trimmed = account?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "default";
}

/** 基于事件ID生成确定性媒体资源ID */
function mediaIdForEvent(eventId: string): string {
  return `media:${createHash("sha256").update(eventId).digest("hex")}`;
}

/**
 * 群聊消息是否进入 Agent Turn（ADR-0006）。
 * 群会话（conversationRef 以 @chatroom 结尾）应用群聊响应策略；
 * 私聊始终接受。策略默认仅被 @ 时回复，可经 Solution 配置覆盖。
 */
function shouldAcceptForAgentTurn(event: NormalizedChannelEvent): boolean {
  const isGroup = event.conversationId.endsWith("@chatroom");
  if (!isGroup) return true;
  return shouldRespondToGroupMessage(DEFAULT_GROUP_CHAT_POLICY, {
    text: event.content,
    mentioned: event.mentioned === true,
  });
}

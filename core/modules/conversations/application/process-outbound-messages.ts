/**
 * 出站消息处理模块
 * 将待发送的消息通过通道发送操作投递到目标渠道。
 * 支持按回复批次顺序发送、发送操作对账和状态回写。
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { and, asc, eq, inArray, lt, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import {
  stageOutboundMedia,
  tryCleanupOutboundMediaStaging,
} from "../../../infrastructure/media/outbound-media-staging.js";
import type {
  ChannelSendOperation,
  ChannelSendOperations,
  ChannelSendPayload,
} from "../../channel/contracts/channel-send-operations.js";
import { ChannelSendRejectedError } from "../../channel/contracts/channel-send-operations.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";

/** 出站媒体信息（从 mediaAssets + storedFiles 查询） */
type OutboundMediaInfo = {
  kind: "image" | "file";
  localPath: string;
  originalName?: string;
};

/**
 * 处理待发送的出站消息。
 * 保证同一回复批次内消息按序发送，通过正式 Channel Send seam 创建或查询发送操作，
 * 并将发送状态回写到数据库。
 */
export async function processOutboundMessages(
  db: NodePgDatabase<typeof schema>,
  client: ChannelSendOperations,
  options: {
    conversationId?: string;
    fileStorageRoot?: string;
    /** 结构化日志（出站轮询注入 pino logger；测试可省略） */
    logger?: {
      warn?: (obj: object, msg: string) => void;
      info?: (obj: object, msg: string) => void;
    };
  } = {},
): Promise<void> {
  const messages = await db
    .select({
      messageId: schema.messages.messageId,
      conversationId: schema.messages.conversationId,
      channelConversationId: schema.conversations.channelConversationId,
      channelAccount: schema.conversations.channelAccount,
      text: schema.messages.text,
      sendState: schema.messages.sendState,
      sendOperationId: schema.messages.sendOperationId,
      sendError: schema.messages.sendError,
      replyBatchId: schema.messages.replyBatchId,
      replySequence: schema.messages.replySequence,
      actorType: schema.messages.actorType,
      replyToChannelMessageId: schema.messages.replyToChannelMessageId,
      mentionContactRefs: schema.messages.mentionContactRefs,
      contentType: schema.messages.contentType,
    })
    .from(schema.messages)
    .innerJoin(
      schema.conversations,
      eq(schema.conversations.conversationId, schema.messages.conversationId),
    )
    .where(
      and(
        inArray(schema.messages.sendState, [
          "pending",
          "submitting",
          "unknown",
        ]),
        options.conversationId
          ? eq(schema.messages.conversationId, options.conversationId)
          : undefined,
      ),
    )
    .orderBy(asc(schema.messages.createdAt))
    .limit(20);

  for (const message of messages) {
    if (message.replyBatchId && (message.replySequence ?? 1) > 1) {
      const prior = await db
        .select({
          messageId: schema.messages.messageId,
          text: schema.messages.text,
        })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.replyBatchId, message.replyBatchId),
            lt(schema.messages.replySequence, message.replySequence ?? 1),
            // 只在前面分段仍「待发送/发送中」时阻塞；unknown/held/failed 等
            // 终态不再挡住后续分段
            inArray(schema.messages.sendState, ["pending", "submitting"]),
          ),
        )
        .limit(1);
      const firstPrior = prior[0];
      if (firstPrior) {
        // 即使乐观行仍 pending/submitting，若事件同步已产生 delivered 副本
        // （消息实际已送达渠道），后续分段不应被永久阻塞。
        const delivered = await db
          .select({ messageId: schema.messages.messageId })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.conversationId, message.conversationId),
              eq(schema.messages.text, firstPrior.text),
              eq(schema.messages.sendState, "observed"),
              eq(schema.messages.isSelf, true),
            ),
          )
          .limit(1);
        if (delivered.length === 0) continue;
      }
    }

    // AI Kill Switch 最终硬门（代码级，不依赖 Turn 侧判断）：
    // 按消息来源分类——human/system（含程序化 handoff 确认语）永远允许；
    // agent 消息在 auto_send_enabled OFF 时绝对禁止发送。
    // fresh 读真值，即使 Turn 事务在开关翻转前已提交 outbound 也能拦住。
    // 已 pending 的 AI 出站置为 held（终态，恢复开关后不自动补发，不重复生成）。
    if (message.actorType === "agent" && message.sendState !== "unknown") {
      const runtime = await readRuntimeSettings(db, undefined, {
        fresh: true,
      });
      if (!runtime.autoSendEnabled) {
        await db
          .update(schema.messages)
          .set({ sendState: "held", sendUpdatedAt: new Date() })
          .where(eq(schema.messages.messageId, message.messageId));
        continue;
      }
    }

    let operationId = message.sendOperationId;
    if (!operationId) {
      // 没有 operationId 的 unknown 无法安全对账；保持原状态，绝不生成替代操作。
      if (message.sendState === "unknown") continue;
      operationId = operationIdForMessage(message.messageId);
      await db
        .update(schema.messages)
        .set({
          sendOperationId: operationId,
          sendState: "submitting",
          sendUpdatedAt: new Date(),
        })
        .where(eq(schema.messages.messageId, message.messageId));
    }

    // 查询媒体信息（如果消息是媒体类型）。
    // 暂存失败（存储文件缺失/IO 错误）按瞬时故障处理：保持 pending/submitting，
    // 本轮跳过、下轮轮询重试；绝不标记 unknown（ADR：unknown 无操作不可自动重建）。
    let mediaInfo: OutboundMediaInfo | null = null;
    if (message.contentType === "media" && options.fileStorageRoot) {
      try {
        mediaInfo = await queryOutboundMedia(
          db,
          message.messageId,
          options.fileStorageRoot,
        );
      } catch (error) {
        options.logger?.warn?.(
          { err: error, messageId: message.messageId },
          "outbound media staging failed; will retry next cycle",
        );
        continue;
      }
    }

    const directiveKind = ((): "recall" | null => {
      // 约定：撤回指令以 contentType=recall 的空文本消息承载（后续可改为专用列）
      if (message.contentType === "recall") return "recall";
      return null;
    })();
    let reconciliation: ReconcileSendOperationResult;
    try {
      reconciliation = await reconcileSendOperation(client, {
        operationId,
        conversationId: message.channelConversationId,
        account: message.channelAccount,
        text: message.text,
        replyToChannelMessageId: message.replyToChannelMessageId,
        mentionContactRefs: message.mentionContactRefs,
        sendState: message.sendState ?? "pending",
        media: mediaInfo,
        ...(directiveKind ? { directiveKind } : {}),
      });
    } catch (error) {
      // 单条隔离：Host 以 400/413/422 拒收说明该消息 payload 本身无效
      // （协议字段缺失、非法、过大），原样重试无意义。标记 failed 终态
      // 并继续处理后续消息；认证/冲突/传输类故障仍中断整轮等待下一轮
      // 重试，避免一条毒消息队头堵塞冻结整个出站队列。
      if (error instanceof ChannelSendRejectedError) {
        options.logger?.warn?.(
          { messageId: message.messageId, httpStatus: error.httpStatus },
          "outbound message rejected by channel host; marked failed",
        );
        await db
          .update(schema.messages)
          .set({
            sendState: "failed",
            sendError: `channel_rejected_http_${String(error.httpStatus)}`,
            sendUpdatedAt: new Date(),
          })
          .where(eq(schema.messages.messageId, message.messageId));
        continue;
      }
      throw error;
    }
    if (reconciliation.outcome === "unknown") {
      await db
        .update(schema.messages)
        .set({
          sendState: "unknown",
          sendError: reconciliation.error ?? message.sendError,
          sendUpdatedAt: new Date(),
        })
        .where(eq(schema.messages.messageId, message.messageId));
      continue;
    }
    await applySendOperation(
      db,
      message.messageId,
      message.conversationId,
      reconciliation.operation,
      options.fileStorageRoot,
    );
  }
}

type ReconcileSendOperationInput = {
  operationId: string;
  conversationId: string;
  /** 账号维度（ADR-0005 多账号隔离） */
  account?: string | null;
  text: string;
  /** 引用回复的原通道消息（ADR-0006） */
  replyToChannelMessageId?: string | null;
  /** @ 提及的通道联系人（ADR-0006） */
  mentionContactRefs?: string[];
  sendState: string;
  /** 出站媒体信息（图片/文件；出站语音转发已随协议 v5 裁剪） */
  media?: OutboundMediaInfo | null;
  /** 出站纯指令类（recall 等非文本/媒体） */
  directiveKind?: "recall" | null;
};

type ReconcileSendOperationResult =
  | {
      outcome: "resolved";
      operation: ChannelSendOperation;
    }
  | {
      outcome: "unknown";
      error?: string;
    };

/**
 * 通过稳定 operationId 对账出站文本操作。
 * unknown 且源端查不到原操作时保持 unknown，禁止自动创建替代操作。
 */
export async function reconcileSendOperation(
  client: ChannelSendOperations,
  input: ReconcileSendOperationInput,
): Promise<ReconcileSendOperationResult> {
  const existing = await client.get(input.operationId);
  if (existing) {
    return matchesSendOperation(existing, input)
      ? { outcome: "resolved", operation: existing }
      : {
          outcome: "unknown",
          error: "send_operation_identity_conflict",
        };
  }

  if (input.sendState === "unknown") {
    return { outcome: "unknown" };
  }

  const created = await client.create({
    operationId: input.operationId,
    conversationRef: input.conversationId,
    ...(input.account ? { account: input.account } : {}),
    payload: buildOutboundPayload(input),
  });
  return matchesSendOperation(created, input)
    ? { outcome: "resolved", operation: created }
    : {
        outcome: "unknown",
        error: "send_operation_identity_conflict",
      };
}

/** 根据消息字段构建出站 payload（ADR-0006：引用/@ 优先于纯文本） */
export function buildOutboundPayload(
  input: ReconcileSendOperationInput,
): ChannelSendPayload {
  if (input.directiveKind === "recall") return { kind: "recall" };
  // 媒体消息：图片/文件（出站语音转发已随协议 v5 裁剪）
  if (input.media) {
    const { kind, localPath, originalName } = input.media;
    if (kind === "file" && originalName) {
      return { kind: "file", path: localPath, fileName: originalName };
    }
    if (kind === "file") {
      return { kind: "file", path: localPath };
    }
    return { kind, path: localPath };
  }
  if (input.replyToChannelMessageId) {
    return {
      kind: "reply",
      text: input.text,
      replyToChannelMessageId: input.replyToChannelMessageId,
    };
  }
  if (input.mentionContactRefs && input.mentionContactRefs.length > 0) {
    return {
      kind: "mention",
      text: input.text,
      mentionContactRefs: input.mentionContactRefs,
    };
  }
  return { kind: "text", text: input.text };
}

function matchesSendOperation(
  operation: ChannelSendOperation,
  input: ReconcileSendOperationInput,
): boolean {
  if (operation.payload.kind === "recall" && input.directiveKind === "recall") {
    return (
      operation.operationId === input.operationId &&
      operation.conversationRef === input.conversationId
    );
  }
  return (
    operation.operationId === input.operationId &&
    sendOperationMatches(
      operation,
      input.conversationId,
      input.text,
      input.media,
    )
  );
}

/** 校验 Channel 发送操作是否与本地消息的会话和内容一致 */
export function sendOperationMatches(
  operation: ChannelSendOperation,
  conversationId: string,
  text: string,
  media?: OutboundMediaInfo | null,
): boolean {
  if (operation.conversationRef !== conversationId) return false;
  // 指令类（recall）无文本/媒体，仅比 kind
  if (operation.payload.kind === "recall") return true;
  // 媒体消息匹配：检查 kind 和 path
  if (media) {
    const payload = operation.payload;
    if (payload.kind === "image" || payload.kind === "file") {
      return (payload as { path: string }).path === media.localPath;
    }
    return false;
  }
  // 文本类消息匹配
  if (
    operation.payload.kind === "text" ||
    operation.payload.kind === "reply" ||
    operation.payload.kind === "mention"
  ) {
    return operation.payload.text === text;
  }
  return false;
}

/** 基于消息ID生成确定性发送操作ID（s2_ 前缀） */
export function operationIdForMessage(messageId: string): string {
  return `s2_${createHash("sha256").update(messageId).digest("hex")}`;
}

/** 将 Channel 发送操作结果同步回本地消息记录，处理渠道消息ID冲突 */
async function applySendOperation(
  db: NodePgDatabase<typeof schema>,
  messageId: string,
  conversationId: string,
  operation: ChannelSendOperation,
  fileStorageRoot?: string,
): Promise<void> {
  if (operation.channelMessageId) {
    const collision = await db
      .select({ messageId: schema.messages.messageId })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.channelMessageId, operation.channelMessageId),
          eq(schema.messages.conversationId, conversationId),
          ne(schema.messages.messageId, messageId),
        ),
      )
      .limit(1);
    if (collision.length > 0) {
      await db
        .update(schema.messages)
        .set({
          sendState: "unknown",
          sendError: "send_operation_channel_message_conflict",
          sendUpdatedAt: new Date(),
        })
        .where(eq(schema.messages.messageId, messageId));
      return;
    }
  }
  // executing 与 pending 一样属于「仍在途」：Host 已认领并正在 GUI 发送，
  // 不应把消息标记为已发送，也不应回写为失败。
  const sendState =
    operation.state === "pending" || operation.state === "executing"
      ? "submitting"
      : operation.state;
  await db
    .update(schema.messages)
    .set({
      sendState,
      sendError: operation.error,
      sendUpdatedAt: new Date(operation.updatedAt),
      // 仅在有真实通道消息ID时回写；null（pending/executing 在途态）不得
      // 抹掉 ingest 回声融合已回填的 channelMessageId（唯一约束的防重锚点）。
      ...(operation.channelMessageId
        ? { channelMessageId: operation.channelMessageId }
        : {}),
    })
    .where(eq(schema.messages.messageId, messageId));
  // 终态清理：confirmed/failed 的暂存文件不再需要；
  // unknown 不清理——操作可能仍在途或待对账，重试路径依赖暂存文件幂等存在。
  if (
    fileStorageRoot &&
    (sendState === "confirmed" || sendState === "failed")
  ) {
    await tryCleanupOutboundMediaStaging(fileStorageRoot, messageId);
  }
}

/**
 * 查询消息关联的出站媒体信息。
 * 从 mediaAssets + storedFiles 获取媒体种类和本地文件路径。
 *
 * 图片/文件出站走「暂存原名路径」：存储层落盘的是无扩展名 UUID 文件，
 * 微信粘贴路线（channel-host）依赖真实文件名区分图片/文件并呈现附件名，
 * 因此先把原始文件复制到 media-outbound 暂存目录（幂等），返回暂存路径。
 * 出站语音转发已随协议 v5 裁剪：voice 资产不再出站（见 normalizeMediaKind）。
 */
async function queryOutboundMedia(
  db: NodePgDatabase<typeof schema>,
  messageId: string,
  fileStorageRoot: string,
): Promise<OutboundMediaInfo | null> {
  const rows = await db
    .select({
      kind: schema.mediaAssets.kind,
      mimeType: schema.storedFiles.mimeType,
      storageKey: schema.storedFiles.storageKey,
      originalName: schema.storedFiles.originalName,
      ownerModule: schema.storedFiles.ownerModule,
    })
    .from(schema.mediaAssets)
    .innerJoin(
      schema.storedFiles,
      eq(schema.mediaAssets.originalFileId, schema.storedFiles.fileId),
    )
    .where(eq(schema.mediaAssets.messageId, messageId))
    .limit(1);

  const row = rows[0];
  if (!row || !row.storageKey) return null;

  // 将 kind 标准化为出站 payload 支持的类型
  const kind = normalizeMediaKind(row.kind);
  if (!kind) return null;

  // 构建本地文件路径：按 ownerModule 解析存储子目录（素材在 assets/，
  // 其余（manual-upload / 通道媒体同步）历史上都落在 media/ 下）
  const sourcePath = join(
    fileStorageRoot,
    storedFilesDirectory(row.ownerModule),
    row.storageKey,
  );

  // 图片/文件：暂存为「原始文件名」，微信粘贴路线才能正确分类与展示。
  // originalName 上报为暂存文件名（净化+扩展名后），与实际粘贴文件严格一致。
  const staged = await stageOutboundMedia(fileStorageRoot, {
    kind,
    sourcePath,
    originalName: row.originalName || "attachment",
    mimeType: row.mimeType || "application/octet-stream",
    messageId,
    mediaIndex: 0,
  });
  return {
    kind,
    localPath: staged.stagedPath,
    ...(kind === "file" ? { originalName: staged.stagedFileName } : {}),
  };
}

/**
 * 将 mediaAssets.kind 标准化为出站 payload 支持的类型。
 * voice/audio 一律返回 null（出站语音转发已随协议 v5 裁剪，语音资产不出站）。
 */
function normalizeMediaKind(kind: string): "image" | "file" | null {
  switch (kind) {
    case "image":
      return "image";
    case "file":
    case "video":
    case "document":
      return "file";
    default:
      return null;
  }
}

/** 按存储行 ownerModule 解析文件存储子目录（素材空间独立目录，其余回落 media/） */
function storedFilesDirectory(ownerModule: string): string {
  return ownerModule === "asset" ? "assets" : "media";
}

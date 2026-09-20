/**
 * 人工触发的通道动作（application 层）：拍一拍与历史回溯同步。
 *
 * 会话存在性与 Handoff 接管权限在这里校验；Channel Host 访问经
 * ChannelActionsPort 接缝（HttpChannelProvider 结构化满足），provider
 * 错误在此翻译为带 httpStatus 的应用错误，interface 只做 HTTP 塑形。
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { ChannelProviderError } from "../../../infrastructure/channel/http-channel-provider.js";
import type {
  ChannelSendOperation,
  CreateChannelSendOperationInput,
} from "../../channel/contracts/channel-send-operations.js";
import { ChannelSendRejectedError } from "../../channel/contracts/channel-send-operations.js";

/** Channel Host 发送/回溯能力端口（HttpChannelProvider 结构化满足） */
export interface ChannelActionsPort {
  create(input: CreateChannelSendOperationInput): Promise<ChannelSendOperation>;
  requestBackfillSync(): Promise<{ started: boolean }>;
}

/** provider 错误的统一应用形态：interface 据此映射 HTTP 状态与错误码 */
export class ChannelActionError extends Error {
  public constructor(
    public readonly errorCode: "poke_failed" | "channel_host_error",
    message: string,
    public readonly httpStatus: number | undefined,
  ) {
    super(message);
    this.name = "ChannelActionError";
  }
}

export type PokeResult =
  | {
      status: "ok";
      operation: {
        operationId: string;
        state: string;
        channelMessageId: string | null;
      };
    }
  | { status: "conversation_not_found" }
  | { status: "not_assignee" }
  | { status: "provider_error"; error: ChannelActionError };

/**
 * 拍一拍：直接经 Channel Host 的 send API 触发，不创建本地消息记录；
 * 结果由事件轮询从 Channel Host 同步回来。
 */
export async function sendConversationPoke(
  db: NodePgDatabase<typeof schema>,
  channel: ChannelActionsPort,
  input: { conversationId: string; operatorUserId: string },
): Promise<PokeResult> {
  const conversationRows = await db
    .select({
      channelConversationId: schema.conversations.channelConversationId,
      channelAccount: schema.conversations.channelAccount,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, input.conversationId))
    .limit(1);
  const conversation = conversationRows[0];
  if (!conversation) {
    return { status: "conversation_not_found" };
  }
  const handoffRows = await db
    .select({
      status: schema.handoffStates.status,
      assignedUserId: schema.handoffStates.assignedUserId,
    })
    .from(schema.handoffStates)
    .where(eq(schema.handoffStates.conversationId, input.conversationId))
    .limit(1);
  const handoff = handoffRows[0];
  if (
    !handoff ||
    handoff.status !== "in_progress" ||
    handoff.assignedUserId !== input.operatorUserId
  ) {
    return { status: "not_assignee" };
  }
  // 走 Channel Send 接缝（provider.create）：协议校验、认证与错误翻译
  // 与出站链路同源（曾为路由层裸 fetch，绕过全部护栏）。
  const operationId = `poke:${randomUUID()}`;
  try {
    const operation = await channel.create({
      operationId,
      conversationRef: conversation.channelConversationId,
      ...(conversation.channelAccount
        ? { account: conversation.channelAccount }
        : {}),
      payload: { kind: "poke" },
    });
    return {
      status: "ok",
      operation: {
        operationId: operation.operationId,
        state: operation.state,
        channelMessageId: operation.channelMessageId ?? null,
      },
    };
  } catch (error) {
    if (error instanceof ChannelSendRejectedError) {
      return {
        status: "provider_error",
        error: new ChannelActionError(
          "poke_failed",
          error.message,
          error.httpStatus,
        ),
      };
    }
    if (error instanceof ChannelProviderError) {
      return {
        status: "provider_error",
        error: new ChannelActionError(
          "channel_host_error",
          error.message,
          error.httpStatus,
        ),
      };
    }
    throw error;
  }
}

export type BackfillSyncResult =
  | { status: "ok"; started: boolean }
  | { status: "provider_error"; error: ChannelActionError };

/** 历史回溯同步（管理员）：请求 Channel Host 以 historical 通道重扫，异步执行 */
export async function requestChannelBackfillSync(
  channel: ChannelActionsPort,
): Promise<BackfillSyncResult> {
  try {
    const result = await channel.requestBackfillSync();
    return { status: "ok", started: result.started };
  } catch (error) {
    if (error instanceof ChannelProviderError) {
      return {
        status: "provider_error",
        error: new ChannelActionError(
          "channel_host_error",
          error.message,
          error.httpStatus,
        ),
      };
    }
    throw error;
  }
}

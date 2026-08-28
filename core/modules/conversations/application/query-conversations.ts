/**
 * 会话查询模块
 * 提供会话列表查询、消息记录分页读取、已读状态标记等功能。
 * 用于管理端界面展示会话列表和聊天记录。
 */

import {
  and,
  desc,
  eq,
  ilike,
  isNotNull,
  isNull,
  lt,
  max,
  not,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

/** and()/or() 的 drizzle 返回可能为 undefined（参数含可选时），这里保证得到 SQL */
function allOf(...conditions: SQLWrapper[]): SQL {
  return and(...conditions) ?? sql`true`;
}

/** 与 allOf 对应的 or 版本；无条件时回退 false 而非 undefined */
function anyOf(...conditions: SQLWrapper[]): SQL {
  return or(...conditions) ?? sql`false`;
}

/** 会话列表范围（服务端计算，Console 三区；all = 真正全部可见会话） */
export type ConversationListScope = "attention" | "mine" | "others" | "all";

/** 会话列表游标：attention 额外携带 score（handoff 权重+未读） */
export type ConversationListCursor = {
  score?: number;
  latestMessageAt: string;
  conversationId: string;
};

export function encodeConversationListCursor(
  cursor: ConversationListCursor,
): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** 从 base64url 解码会话列表游标，格式无效返回 undefined */
export function decodeConversationListCursor(
  input: string,
): ConversationListCursor | undefined {
  try {
    const raw = JSON.parse(
      Buffer.from(input, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const value = raw as {
      score?: unknown;
      latestMessageAt?: unknown;
      conversationId?: unknown;
    };
    if (
      typeof value.latestMessageAt !== "string" ||
      typeof value.conversationId !== "string"
    ) {
      return undefined;
    }
    const latestMessageAt = new Date(value.latestMessageAt);
    if (Number.isNaN(latestMessageAt.getTime())) return undefined;
    return {
      ...(typeof value.score === "number" ? { score: value.score } : {}),
      latestMessageAt: latestMessageAt.toISOString(),
      conversationId: value.conversationId,
    };
  } catch {
    return undefined;
  }
}

/** 会话级操作权限（服务端计算；Console 缺失即只读，不猜） */
export type ConversationPermissions = {
  canView: boolean;
  canManualTakeover: boolean;
  canReply: boolean;
  canTransfer: boolean;
  canFinish: boolean;
};

/**
 * 计算会话操作权限。
 * 业务模型（锁定）：canManualTakeover 严格 = AGENT_ACTIVE（无 handoff 或 agentPaused=false）；
 * pending 走 Claim、transfer_pending 走 Accept Transfer，均不属于 manual takeover。
 */
export function computeConversationPermissions(
  handoff: {
    status: string | null;
    assignedUserId: string | null;
    agentPaused: boolean | null;
  } | null,
  userId: string,
): ConversationPermissions {
  const agentActive = !handoff || !handoff.agentPaused;
  const mine =
    handoff?.status === "in_progress" && handoff.assignedUserId === userId;
  return {
    canView: true,
    canManualTakeover: agentActive,
    canReply: mine,
    canTransfer: mine,
    canFinish: mine,
  };
}

/**
 * 查询共享会话列表，包含联系人信息、最新消息、人工接管状态、未读计数与操作权限。
 * 支持 scope（attention/mine/others/all）与游标分页（before/limit）；
 * 不传 scope 时保持原有行为（全部会话，按最近消息时间倒序）。
 *
 * agentEnabled 可选：
 * - true  → 仅返回联系人白名单（agent_enabled=true）的会话
 * - false → 仅返回非白名单会话
 * - 不传  → 全部会话（保持向后兼容）
 */
export async function listSharedConversations(
  db: NodePgDatabase<typeof schema>,
  input: {
    limit: number;
    userId: string;
    contactId?: string;
    scope?: ConversationListScope;
    agentEnabled?: boolean;
    before?: string;
  },
) {
  const { limit, userId, scope, before, agentEnabled } = input;
  const cursor = before ? decodeConversationListCursor(before) : undefined;
  const limitWithProbe = limit + 1;
  const unreadCustomerCount = sql<number>`count(*) filter (where ${schema.messages.direction} = 'inbound' and (${schema.conversationReadStates.lastReadAt} is null or ${schema.messages.occurredAt} > ${schema.conversationReadStates.lastReadAt}))`;
  // attention 服务端排序权重：handoff 状态(pending 200/transfer_pending 250/in_progress 100) + 未读
  const attentionScore = sql<number>`(
    CASE ${schema.handoffStates.status} WHEN 'pending' THEN 200 WHEN 'transfer_pending' THEN 250 WHEN 'in_progress' THEN 100 ELSE 0 END
    + ${unreadCustomerCount}
  )`;

  // 注意 SQL 三值逻辑：status 为 NULL（无 handoff 的 AGENT_ACTIVE 会话）时，
  // `status = 'pending'` 求值为 NULL，NOT(NULL)=NULL 会被 WHERE 排除——
  // 因此 mine/attention 条件必须先 isNotNull(status)，others 才能包含 AGENT_ACTIVE。
  const mineCondition = allOf(
    isNotNull(schema.handoffStates.status),
    eq(schema.handoffStates.status, "in_progress"),
    eq(schema.handoffStates.assignedUserId, userId),
  );
  const attentionCondition = anyOf(
    allOf(
      isNotNull(schema.handoffStates.status),
      eq(schema.handoffStates.status, "pending"),
    ),
    allOf(
      isNotNull(schema.handoffStates.status),
      eq(schema.handoffStates.status, "transfer_pending"),
      eq(schema.handoffStates.targetUserId, userId),
    ),
  );
  let scopeCondition: SQL | undefined;
  if (scope === "mine") {
    scopeCondition = mineCondition;
  } else if (scope === "attention") {
    scopeCondition = attentionCondition;
  } else if (scope === "others") {
    scopeCondition = allOf(not(mineCondition), not(attentionCondition));
  }

  const baseQuery = db
    .select({
      conversationId: schema.conversations.conversationId,
      channel: schema.conversations.channel,
      channelConversationId: schema.conversations.channelConversationId,
      latestMessageAt: max(schema.messages.occurredAt),
      latestMessage: {
        text: sql<string>`(array_agg(${schema.messages.text} order by ${schema.messages.occurredAt} desc, ${schema.messages.messageId} desc))[1]`,
        actorType: sql<string>`(array_agg(${schema.messages.actorType} order by ${schema.messages.occurredAt} desc, ${schema.messages.messageId} desc))[1]`,
      },
      contact: {
        contactId: schema.contactProfiles.contactId,
        channelContactId: schema.contactProfiles.channelContactId,
        channelDisplayName: schema.contactProfiles.channelDisplayName,
        channelNickname: schema.contactProfiles.channelNickname,
        channelRemark: schema.contactProfiles.channelRemark,
        avatarUrl: schema.contactProfiles.avatarUrl,
        sharedAlias: schema.contactProfiles.sharedAlias,
        note: schema.contactProfiles.note,
        tags: schema.contactProfiles.tags,
        agentEnabled: schema.contactProfiles.agentEnabled,
      },
      handoffStatus: schema.handoffStates.status,
      handoffReason: schema.handoffStates.reason,
      handoffCreatedAt: schema.handoffStates.createdAt,
      handoffAssignedUserId: schema.handoffStates.assignedUserId,
      handoffAssignedQueueId: schema.handoffStates.assignedQueueId,
      handoffAgentPaused: schema.handoffStates.agentPaused,
      handoffTargetUserId: schema.handoffStates.targetUserId,
      handoffAssigneeUsername: schema.users.username,
      unreadCustomerCount,
    })
    .from(schema.conversations)
    .innerJoin(
      schema.messages,
      eq(schema.messages.conversationId, schema.conversations.conversationId),
    )
    .innerJoin(
      schema.contactProfiles,
      eq(schema.contactProfiles.contactId, schema.conversations.contactId),
    )
    .leftJoin(
      schema.handoffStates,
      eq(
        schema.handoffStates.conversationId,
        schema.conversations.conversationId,
      ),
    )
    .leftJoin(
      schema.conversationReadStates,
      and(
        eq(
          schema.conversationReadStates.conversationId,
          schema.conversations.conversationId,
        ),
        eq(schema.conversationReadStates.userId, userId),
      ),
    )
    .leftJoin(
      schema.users,
      eq(schema.users.userId, schema.handoffStates.assignedUserId),
    )
    .leftJoin(
      schema.conversationVisibility,
      and(
        eq(
          schema.conversationVisibility.conversationId,
          schema.conversations.conversationId,
        ),
        eq(schema.conversationVisibility.userId, userId),
      ),
    )
    .where(
      and(
        isNull(schema.conversationVisibility.hiddenAt),
        // 黑名单联系人的会话不在任何会话列表出现（消息照常入库，联系人页可查）
        eq(schema.contactProfiles.blocked, false),
        input.contactId
          ? eq(schema.conversations.contactId, input.contactId)
          : undefined,
        scopeCondition,
        agentEnabled === true
          ? eq(schema.contactProfiles.agentEnabled, true)
          : agentEnabled === false
            ? eq(schema.contactProfiles.agentEnabled, false)
            : undefined,
      ),
    )
    .groupBy(
      schema.conversations.conversationId,
      schema.contactProfiles.contactId,
      schema.contactProfiles.channelContactId,
      schema.contactProfiles.channelDisplayName,
      schema.contactProfiles.channelNickname,
      schema.contactProfiles.channelRemark,
      schema.contactProfiles.avatarUrl,
      schema.contactProfiles.sharedAlias,
      schema.contactProfiles.note,
      schema.contactProfiles.tags,
      schema.contactProfiles.agentEnabled,
      schema.handoffStates.status,
      schema.handoffStates.reason,
      schema.handoffStates.createdAt,
      schema.handoffStates.assignedUserId,
      schema.handoffStates.assignedQueueId,
      schema.handoffStates.agentPaused,
      schema.handoffStates.targetUserId,
      schema.users.username,
      schema.conversationReadStates.lastReadAt,
    );
  const queryWithCursor = cursor
    ? baseQuery.having(
        scope === "attention"
          ? or(
              lt(attentionScore, cursor.score ?? -1),
              and(
                eq(attentionScore, cursor.score ?? -1),
                or(
                  lt(
                    max(schema.messages.occurredAt),
                    new Date(cursor.latestMessageAt),
                  ),
                  and(
                    eq(
                      max(schema.messages.occurredAt),
                      new Date(cursor.latestMessageAt),
                    ),
                    lt(
                      schema.conversations.conversationId,
                      cursor.conversationId,
                    ),
                  ),
                ),
              ),
            )
          : or(
              lt(
                max(schema.messages.occurredAt),
                new Date(cursor.latestMessageAt),
              ),
              and(
                eq(
                  max(schema.messages.occurredAt),
                  new Date(cursor.latestMessageAt),
                ),
                lt(schema.conversations.conversationId, cursor.conversationId),
              ),
            ),
      )
    : baseQuery;
  const rows = await queryWithCursor
    .orderBy(
      scope === "attention"
        ? desc(attentionScore)
        : desc(max(schema.messages.occurredAt)),
      desc(max(schema.messages.occurredAt)),
      desc(schema.conversations.conversationId),
    )
    .limit(limitWithProbe);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeConversationListCursor({
          ...(scope === "attention"
            ? {
                score:
                  typeof last.unreadCustomerCount === "number"
                    ? handoffRank(last.handoffStatus) + last.unreadCustomerCount
                    : 0,
              }
            : {}),
          latestMessageAt: (last.latestMessageAt instanceof Date
            ? last.latestMessageAt
            : new Date(0)
          ).toISOString(),
          conversationId: last.conversationId,
        })
      : null;

  return {
    conversations: page.map(
      ({
        handoffStatus,
        handoffReason,
        handoffCreatedAt,
        handoffAssignedUserId,
        handoffAssignedQueueId,
        handoffAgentPaused,
        handoffTargetUserId,
        handoffAssigneeUsername,
        ...conversation
      }) => {
        void handoffTargetUserId;
        return {
          ...conversation,
          // pg 对 count(*)（bigint）返回字符串；投影统一转数字，
          // 避免客户端把 "0" 当 truthy 误显示未读红点。
          unreadCustomerCount: Number(conversation.unreadCustomerCount ?? 0),
          handoff: handoffStatus
            ? {
                status: handoffStatus,
                reason: handoffReason,
                createdAt: handoffCreatedAt,
                assignedUserId: handoffAssignedUserId,
                assignedQueueId: handoffAssignedQueueId,
                assignedUser: handoffAssigneeUsername
                  ? { username: handoffAssigneeUsername }
                  : null,
                agentPaused: handoffAgentPaused === true,
              }
            : null,
          permissions: computeConversationPermissions(
            handoffStatus
              ? {
                  status: handoffStatus,
                  assignedUserId: handoffAssignedUserId,
                  agentPaused: handoffAgentPaused,
                }
              : null,
            userId,
          ),
        };
      },
    ),
    nextCursor,
  };
}

/** handoff 状态权重（与 SQL 中 attentionScore 一致） */
function handoffRank(status: string | null): number {
  return status === "pending"
    ? 200
    : status === "transfer_pending"
      ? 250
      : status === "in_progress"
        ? 100
        : 0;
}

/** 搜索当前用户可见的会话和消息，返回匹配消息作为上下文摘要。 */
export async function searchSharedConversations(
  db: NodePgDatabase<typeof schema>,
  input: { userId: string; query: string; limit: number },
) {
  const pattern = `%${input.query}%`;
  const rows = await db
    .select({
      conversationId: schema.conversations.conversationId,
      matchedMessage: {
        text: schema.messages.text,
        occurredAt: schema.messages.occurredAt,
      },
      contact: {
        channelContactId: schema.contactProfiles.channelContactId,
        channelDisplayName: schema.contactProfiles.channelDisplayName,
        channelNickname: schema.contactProfiles.channelNickname,
        channelRemark: schema.contactProfiles.channelRemark,
        sharedAlias: schema.contactProfiles.sharedAlias,
      },
      handoffStatus: schema.handoffStates.status,
      handoffReason: schema.handoffStates.reason,
      handoffCreatedAt: schema.handoffStates.createdAt,
      handoffAssignedUserId: schema.handoffStates.assignedUserId,
    })
    .from(schema.conversations)
    .innerJoin(
      schema.messages,
      eq(schema.messages.conversationId, schema.conversations.conversationId),
    )
    .innerJoin(
      schema.contactProfiles,
      eq(schema.contactProfiles.contactId, schema.conversations.contactId),
    )
    .leftJoin(
      schema.handoffStates,
      eq(
        schema.handoffStates.conversationId,
        schema.conversations.conversationId,
      ),
    )
    .leftJoin(
      schema.conversationVisibility,
      and(
        eq(
          schema.conversationVisibility.conversationId,
          schema.conversations.conversationId,
        ),
        eq(schema.conversationVisibility.userId, input.userId),
      ),
    )
    .where(
      and(
        isNull(schema.conversationVisibility.hiddenAt),
        or(
          ilike(schema.messages.text, pattern),
          ilike(schema.contactProfiles.channelContactId, pattern),
          ilike(schema.contactProfiles.channelDisplayName, pattern),
          ilike(schema.contactProfiles.channelNickname, pattern),
          ilike(schema.contactProfiles.channelRemark, pattern),
          ilike(schema.contactProfiles.sharedAlias, pattern),
          ilike(schema.conversations.conversationId, pattern),
        ),
      ),
    )
    .orderBy(desc(schema.messages.occurredAt), desc(schema.messages.messageId))
    .limit(input.limit * 4);

  const unique = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!unique.has(row.conversationId)) unique.set(row.conversationId, row);
    if (unique.size >= input.limit) break;
  }
  return [...unique.values()].map((row) => ({
    conversationId: row.conversationId,
    matchedMessage: row.matchedMessage,
    contact: row.contact,
    handoff: row.handoffStatus
      ? {
          status: row.handoffStatus,
          reason: row.handoffReason,
          createdAt: row.handoffCreatedAt,
          assignedUserId: row.handoffAssignedUserId,
        }
      : null,
  }));
}

/** 设置当前用户的会话隐藏状态。 */
export async function setConversationHidden(
  db: NodePgDatabase<typeof schema>,
  input: { userId: string; conversationId: string; hidden: boolean },
) {
  const [conversation] = await db
    .select({ conversationId: schema.conversations.conversationId })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, input.conversationId))
    .limit(1);
  if (!conversation) return undefined;
  if (input.hidden) {
    await db
      .insert(schema.conversationVisibility)
      .values({ userId: input.userId, conversationId: input.conversationId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.conversationVisibility)
      .where(
        and(
          eq(schema.conversationVisibility.userId, input.userId),
          eq(
            schema.conversationVisibility.conversationId,
            input.conversationId,
          ),
        ),
      );
  }
  return { conversationId: input.conversationId, hidden: input.hidden };
}

/** 获取当前用户隐藏的会话，供恢复入口使用。 */
export async function listHiddenConversations(
  db: NodePgDatabase<typeof schema>,
  userId: string,
) {
  return db
    .select({
      conversationId: schema.conversations.conversationId,
      hiddenAt: schema.conversationVisibility.hiddenAt,
      contact: {
        channelDisplayName: schema.contactProfiles.channelDisplayName,
        channelNickname: schema.contactProfiles.channelNickname,
        sharedAlias: schema.contactProfiles.sharedAlias,
      },
    })
    .from(schema.conversationVisibility)
    .innerJoin(
      schema.conversations,
      eq(
        schema.conversations.conversationId,
        schema.conversationVisibility.conversationId,
      ),
    )
    .innerJoin(
      schema.contactProfiles,
      eq(schema.contactProfiles.contactId, schema.conversations.contactId),
    )
    .where(
      and(
        eq(schema.conversationVisibility.userId, userId),
        // 黑名单联系人的会话不再出现（含隐藏列表；彻底移除，联系人页可见）
        eq(schema.contactProfiles.blocked, false),
      ),
    )
    .orderBy(desc(schema.conversationVisibility.hiddenAt));
}

export type MessageCursor = {
  occurredAt: Date;
  messageId: string;
};

/** 标记会话为已读，记录用户最后阅读的消息时间戳 */
export async function markConversationRead(
  db: NodePgDatabase<typeof schema>,
  input: { userId: string; conversationId: string; lastReadMessageId: string },
) {
  return db.transaction(async (transaction) => {
    const messages = await transaction
      .select({
        messageId: schema.messages.messageId,
        occurredAt: schema.messages.occurredAt,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, input.conversationId),
          eq(schema.messages.messageId, input.lastReadMessageId),
        ),
      )
      .limit(1);
    const message = messages[0];
    if (!message) return undefined;
    const existing = await transaction
      .select()
      .from(schema.conversationReadStates)
      .where(
        and(
          eq(schema.conversationReadStates.userId, input.userId),
          eq(
            schema.conversationReadStates.conversationId,
            input.conversationId,
          ),
        ),
      )
      .limit(1);
    if (existing[0] && existing[0].lastReadAt >= message.occurredAt) {
      return existing[0];
    }
    const now = new Date();
    const updated = await transaction
      .insert(schema.conversationReadStates)
      .values({
        userId: input.userId,
        conversationId: input.conversationId,
        lastReadMessageId: message.messageId,
        lastReadAt: message.occurredAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.conversationReadStates.userId,
          schema.conversationReadStates.conversationId,
        ],
        set: {
          lastReadMessageId: message.messageId,
          lastReadAt: message.occurredAt,
          updatedAt: now,
        },
      })
      .returning();
    return updated[0];
  });
}

/** 分页获取会话消息记录，支持游标翻页（向前加载历史消息） */
export async function getSharedTranscript(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
  limit: number,
  before?: MessageCursor,
) {
  const [conversation] = await db
    .select({ revision: schema.conversations.revision })
    .from(schema.conversations)
    .where(eq(schema.conversations.conversationId, conversationId))
    .limit(1);
  const rows = await db
    .select({
      messageId: schema.messages.messageId,
      direction: schema.messages.direction,
      actorType: schema.messages.actorType,
      actorId: schema.messages.actorId,
      contentType: schema.messages.contentType,
      mediaId: schema.mediaAssets.mediaId,
      // 图片视觉描述 / 语音转写文字（前端气泡展示）
      mediaDescription: schema.mediaAssets.description,
      text: schema.messages.text,
      processingState: schema.messages.processingState,
      sendState: schema.messages.sendState,
      occurredAt: schema.messages.occurredAt,
    })
    .from(schema.messages)
    .leftJoin(
      schema.mediaAssets,
      eq(schema.mediaAssets.messageId, schema.messages.messageId),
    )
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        before
          ? or(
              lt(schema.messages.occurredAt, before.occurredAt),
              and(
                eq(schema.messages.occurredAt, before.occurredAt),
                lt(schema.messages.messageId, before.messageId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(schema.messages.occurredAt), desc(schema.messages.messageId))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const oldest = page[0];
  return {
    messages: page.map((row) => ({
      ...row,
      // AI 员工头像：actor_id 是 Solution 提供的员工标识（不透明），
      // 经平台 DiceBear 代理按标识确定性出图，Console/Mobile 渲染一致。
      actorAvatarUrl:
        row.actorType === "agent" && row.actorId
          ? `/api/v1/avatars/dicebear/voxel-bot/${encodeURIComponent(row.actorId)}`
          : null,
    })),
    conversationRevision: conversation?.revision ?? 0,
    nextCursor:
      hasMore && oldest
        ? encodeCursor({
            occurredAt: oldest.occurredAt,
            messageId: oldest.messageId,
          })
        : null,
  };
}

/** 将消息游标编码为 base64url 字符串，用于 API 分页参数 */
export function encodeCursor(cursor: MessageCursor): string {
  return Buffer.from(
    JSON.stringify({
      occurredAt: cursor.occurredAt.toISOString(),
      messageId: cursor.messageId,
    }),
  ).toString("base64url");
}

/** 从 base64url 字符串解码消息游标，格式无效时返回 undefined */
export function decodeCursor(input: string): MessageCursor | undefined {
  try {
    const value = JSON.parse(
      Buffer.from(input, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("occurredAt" in value) ||
      !("messageId" in value) ||
      typeof value.occurredAt !== "string" ||
      typeof value.messageId !== "string"
    ) {
      return undefined;
    }
    const occurredAt = new Date(value.occurredAt);
    if (Number.isNaN(occurredAt.getTime()) || value.messageId.length === 0) {
      return undefined;
    }
    return { occurredAt, messageId: value.messageId };
  } catch {
    return undefined;
  }
}

/** 联系人历史会话摘要（正式 Contact History Contract 的返回项） */
export type ContactConversationSummary = {
  conversationId: string;
  latestMessageAt: string | null;
  latestMessageText: string;
  handoffStatus: string | null;
};

/** 联系人历史游标：{latestMessageAt, conversationId} */
export type ContactCursor = {
  latestMessageAt: string;
  conversationId: string;
};

export function encodeContactCursor(cursor: ContactCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** 从 base64url 解码联系人历史游标，格式无效返回 undefined */
export function decodeContactCursor(input: string): ContactCursor | undefined {
  try {
    const raw = JSON.parse(
      Buffer.from(input, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const value = raw as {
      latestMessageAt?: unknown;
      conversationId?: unknown;
    };
    if (
      typeof value.latestMessageAt !== "string" ||
      typeof value.conversationId !== "string"
    ) {
      return undefined;
    }
    const latestMessageAt = new Date(value.latestMessageAt);
    if (
      Number.isNaN(latestMessageAt.getTime()) ||
      value.conversationId.length === 0
    ) {
      return undefined;
    }
    return {
      latestMessageAt: latestMessageAt.toISOString(),
      conversationId: value.conversationId,
    };
  } catch {
    return undefined;
  }
}

/**
 * 按联系人列出全部历史会话（游标分页，按最近消息时间倒序）。
 * contactId 是事实来源；无论是否发生过 Handoff、是否已结束都返回。
 */
export async function listContactConversationsCursor(
  db: NodePgDatabase<typeof schema>,
  input: {
    contactId: string;
    userId: string;
    limit: number;
    before?: string | undefined;
  },
): Promise<{ items: ContactConversationSummary[]; nextCursor: string | null }> {
  const limitWithProbe = input.limit + 1;
  const cursor = input.before ? decodeContactCursor(input.before) : undefined;
  const rows = await db.execute<{
    conversationId: string;
    latestMessageAt: Date | string | null;
    latestMessageText: string | null;
    handoffStatus: string | null;
  }>(sql`
    SELECT
      c.conversation_id AS "conversationId",
      latest.occurred_at AS "latestMessageAt",
      latest.text AS "latestMessageText",
      h.status AS "handoffStatus"
    FROM conversation.conversations c
    JOIN conversation.contact_profiles p ON p.contact_id = c.contact_id
    LEFT JOIN LATERAL (
      SELECT m.occurred_at, m.text
      FROM conversation.messages m
      WHERE m.conversation_id = c.conversation_id
      ORDER BY m.occurred_at DESC, m.message_id DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN conversation.conversation_visibility v
      ON v.conversation_id = c.conversation_id AND v.user_id = ${input.userId}
    LEFT JOIN handoff.states h ON h.conversation_id = c.conversation_id
    WHERE c.contact_id = ${input.contactId}
      AND v.hidden_at IS NULL
      ${
        cursor
          ? sql`AND (
        latest.occurred_at IS NULL
        OR latest.occurred_at < ${new Date(cursor.latestMessageAt)}
        OR (
          latest.occurred_at = ${new Date(cursor.latestMessageAt)}
          AND c.conversation_id < ${cursor.conversationId}
        )
      )`
          : sql``
      }
    ORDER BY latest.occurred_at DESC NULLS LAST, c.conversation_id DESC
    LIMIT ${limitWithProbe}
  `);
  const hasMore = rows.rows.length > input.limit;
  const page = rows.rows.slice(0, input.limit);
  const last = page[page.length - 1] as
    | { conversationId: string; latestMessageAt: Date | string | null }
    | undefined;
  const nextCursor =
    hasMore && last
      ? encodeContactCursor({
          latestMessageAt:
            last.latestMessageAt instanceof Date
              ? last.latestMessageAt.toISOString()
              : new Date(last.latestMessageAt ?? "").toISOString(),
          conversationId: last.conversationId,
        })
      : null;
  return {
    items: page.map((row) => ({
      conversationId: row.conversationId,
      latestMessageAt: row.latestMessageAt
        ? row.latestMessageAt instanceof Date
          ? row.latestMessageAt.toISOString()
          : new Date(row.latestMessageAt).toISOString()
        : null,
      latestMessageText: row.latestMessageText ?? "",
      handoffStatus: row.handoffStatus,
    })),
    nextCursor,
  };
}

/** 联系人列表项（按联系人聚合最近会话） */
export type ContactListSummary = {
  contactId: string;
  channelDisplayName: string | null;
  channelNickname: string | null;
  channelRemark: string | null;
  sharedAlias: string | null;
  avatarUrl: string | null;
  conversationId: string;
  latestMessageAt: string | null;
  latestMessageText: string;
  /** 联系人白名单：true = 由 Agent 负责；false = 仅人工处理 */
  agentEnabled: boolean;
  /** 黑名单：true = 不进会话列表（本列表可见）、不建 Turn、不推通知 */
  blocked: boolean;
  /** 首次联系时间（最早一条消息） */
  firstContactAt: string | null;
  /** 历史会话总数 */
  conversationCount: number;
  /** 最近一次人工处理人（accept / manual_taken_over 的执行者） */
  lastHandlerName: string | null;
  /** 最近一次人工处理时间 */
  lastHandlerAt: string | null;
};

/** 联系人列表游标：{latestMessageAt, contactId} */
export type ContactListCursor = {
  latestMessageAt: string;
  contactId: string;
};

export function encodeContactListCursor(cursor: ContactListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeContactListCursor(
  input: string,
): ContactListCursor | undefined {
  try {
    const raw = JSON.parse(
      Buffer.from(input, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const value = raw as { latestMessageAt?: unknown; contactId?: unknown };
    if (
      typeof value.latestMessageAt !== "string" ||
      typeof value.contactId !== "string"
    ) {
      return undefined;
    }
    const latestMessageAt = new Date(value.latestMessageAt);
    if (Number.isNaN(latestMessageAt.getTime())) return undefined;
    return {
      latestMessageAt: latestMessageAt.toISOString(),
      contactId: value.contactId,
    };
  } catch {
    return undefined;
  }
}

/**
 * 联系人通讯录（按联系人聚合其可见会话的最近一条消息）。
 * 游标分页 {latestMessageAt, contactId}，排序最近消息倒序。
 *
 * 可选参数：
 * - q：按 channelDisplayName / channelNickname / channelRemark / sharedAlias 模糊匹配（ILIKE）
 * - agentEnabled：true=仅白名单、false=仅非白名单、不传=全部
 */
export async function listContactsWithLatestConversation(
  db: NodePgDatabase<typeof schema>,
  input: {
    userId: string;
    limit: number;
    before?: string | undefined;
    q?: string | undefined;
    agentEnabled?: boolean | undefined;
  },
): Promise<{ items: ContactListSummary[]; nextCursor: string | null }> {
  const limitWithProbe = input.limit + 1;
  const cursor = input.before
    ? decodeContactListCursor(input.before)
    : undefined;
  const trimmedQuery = input.q?.trim() ?? "";
  const searchPattern =
    trimmedQuery.length > 0 ? `%${trimmedQuery.replace(/[%_]/g, "\\$&")}%` : null;
  const agentEnabledFilter = input.agentEnabled;
  const rows = await db.execute<{
    contactId: string;
    channelDisplayName: string | null;
    channelNickname: string | null;
    channelRemark: string | null;
    sharedAlias: string | null;
    avatarUrl: string | null;
    conversationId: string;
    latestMessageAt: Date | string | null;
    latestMessageText: string | null;
    agentEnabled: boolean;
    blocked: boolean;
    firstContactAt: Date | string | null;
    conversationCount: number;
    lastHandlerName: string | null;
    lastHandlerAt: Date | string | null;
  }>(sql`
    SELECT
      p.contact_id AS "contactId",
      p.channel_display_name AS "channelDisplayName",
      p.channel_nickname AS "channelNickname",
      p.channel_remark AS "channelRemark",
      p.shared_alias AS "sharedAlias",
      p.avatar_url AS "avatarUrl",
      lc.conversation_id AS "conversationId",
      lc.latest_message_at AS "latestMessageAt",
      lc.latest_message_text AS "latestMessageText",
      p.agent_enabled AS "agentEnabled",
      p.blocked AS "blocked",
      -- 联系人维度聚合：首末联系时间 / 会话总数 / 最近一次人工处理人与时间
      (SELECT MIN(msg.occurred_at) FROM conversation.messages msg
        JOIN conversation.conversations cc ON cc.conversation_id = msg.conversation_id
        WHERE cc.contact_id = p.contact_id) AS "firstContactAt",
      (SELECT COUNT(*) FROM conversation.conversations cc WHERE cc.contact_id = p.contact_id) AS "conversationCount",
      last_human.handler_name AS "lastHandlerName",
      last_human.handled_at AS "lastHandlerAt"
    FROM conversation.contact_profiles p
    JOIN LATERAL (
      SELECT c.conversation_id, m.occurred_at AS latest_message_at, m.text AS latest_message_text
      FROM conversation.conversations c
      LEFT JOIN LATERAL (
        SELECT msg.occurred_at, msg.text
        FROM conversation.messages msg
        WHERE msg.conversation_id = c.conversation_id
        ORDER BY msg.occurred_at DESC, msg.message_id DESC
        LIMIT 1
      ) m ON true
      LEFT JOIN conversation.conversation_visibility v
        ON v.conversation_id = c.conversation_id AND v.user_id = ${input.userId}
      WHERE c.contact_id = p.contact_id AND v.hidden_at IS NULL
      ORDER BY m.occurred_at DESC NULLS LAST, c.conversation_id DESC
      LIMIT 1
    ) lc ON true
    LEFT JOIN LATERAL (
      SELECT u.username AS handler_name, ev.created_at AS handled_at
      FROM handoff.events ev
      JOIN identity.users u ON u.user_id = ev.actor_user_id
      JOIN conversation.conversations cc ON cc.conversation_id = ev.conversation_id
      WHERE cc.contact_id = p.contact_id
        AND ev.event_type IN ('accepted', 'manual_taken_over')
      ORDER BY ev.created_at DESC
      LIMIT 1
    ) last_human ON true
    WHERE lc.conversation_id IS NOT NULL
      ${
        cursor
          ? sql`AND (
        lc.latest_message_at < ${new Date(cursor.latestMessageAt)}
        OR (
          lc.latest_message_at = ${new Date(cursor.latestMessageAt)}
          AND p.contact_id < ${cursor.contactId}
        )
      )`
          : sql``
      }
      ${
        searchPattern
          ? sql`AND (
        p.channel_display_name ILIKE ${searchPattern}
        OR p.channel_nickname ILIKE ${searchPattern}
        OR p.channel_remark ILIKE ${searchPattern}
        OR p.shared_alias ILIKE ${searchPattern}
      )`
          : sql``
      }
      ${
        agentEnabledFilter === true
          ? sql`AND p.agent_enabled = true`
          : agentEnabledFilter === false
            ? sql`AND p.agent_enabled = false`
            : sql``
      }
    ORDER BY lc.latest_message_at DESC NULLS LAST, p.contact_id DESC
    LIMIT ${limitWithProbe}
  `);
  const hasMore = rows.rows.length > input.limit;
  const page = rows.rows.slice(0, input.limit);
  const last = page[page.length - 1] as
    { contactId: string; latestMessageAt: Date | string | null } | undefined;
  const nextCursor =
    hasMore && last
      ? encodeContactListCursor({
          latestMessageAt:
            last.latestMessageAt instanceof Date
              ? last.latestMessageAt.toISOString()
              : new Date(last.latestMessageAt ?? "").toISOString(),
          contactId: last.contactId,
        })
      : null;
  return {
    items: page.map((row) => ({
      contactId: row.contactId,
      channelDisplayName: row.channelDisplayName,
      channelNickname: row.channelNickname,
      channelRemark: row.channelRemark,
      sharedAlias: row.sharedAlias,
      avatarUrl: row.avatarUrl,
      conversationId: row.conversationId,
      latestMessageAt: row.latestMessageAt
        ? row.latestMessageAt instanceof Date
          ? row.latestMessageAt.toISOString()
          : new Date(row.latestMessageAt).toISOString()
        : null,
      latestMessageText: row.latestMessageText ?? "",
      agentEnabled: row.agentEnabled,
      blocked: row.blocked,
      firstContactAt: row.firstContactAt
        ? row.firstContactAt instanceof Date
          ? row.firstContactAt.toISOString()
          : new Date(row.firstContactAt).toISOString()
        : null,
      // pg 的 count(*)（bigint）返回字符串，统一转数字
      conversationCount: Number(row.conversationCount ?? 0),
      lastHandlerName: row.lastHandlerName,
      lastHandlerAt: row.lastHandlerAt
        ? row.lastHandlerAt instanceof Date
          ? row.lastHandlerAt.toISOString()
          : new Date(row.lastHandlerAt).toISOString()
        : null,
    })),
    nextCursor,
  };
}

/**
 * 联系人资料服务模块
 * 提供联系人资料的查询、更新、别名管理和 Agent 启用状态检查。
 * 更新时记录审计事件，禁用 Agent 时自动取消排队中的 Agent Turn。
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { AgentTurnService } from "../../agent/application/agent-turn-service.js";

/** 联系人资料可更新字段 */
export type ContactProfilePatch = {
  note?: string | null | undefined;
  tags?: string[] | undefined;
  agentEnabled?: boolean | undefined;
  sharedAlias?: string | null | undefined;
};

/** 根据渠道和渠道联系人ID生成确定性联系人ID */
export function contactIdForChannel(
  channel: string,
  channelContactId: string,
): string {
  return `contact:${channel}:${channelContactId}`;
}

/** 通过会话ID查询关联的联系人资料 */
export async function getConversationContactProfile(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
): Promise<typeof schema.contactProfiles.$inferSelect | undefined> {
  const profiles = await db
    .select({ profile: schema.contactProfiles })
    .from(schema.conversations)
    .innerJoin(
      schema.contactProfiles,
      eq(schema.contactProfiles.contactId, schema.conversations.contactId),
    )
    .where(eq(schema.conversations.conversationId, conversationId))
    .limit(1);
  return profiles[0]?.profile;
}

/**
 * 更新会话关联的联系人资料。
 * 记录别名变更事件，禁用 Agent 时自动取消排队的 Agent Turn 和待发送消息。
 */
export async function updateConversationContactProfile(
  db: NodePgDatabase<typeof schema>,
  input: {
    conversationId: string;
    actorUserId: string;
    sourceIp: string;
    patch: ContactProfilePatch;
  },
): Promise<
  | { status: "ok"; profile: typeof schema.contactProfiles.$inferSelect }
  | { status: "conversation_not_found" }
> {
  return db.transaction(async (transaction) => {
    const conversations = await transaction
      .select({ contactId: schema.conversations.contactId })
      .from(schema.conversations)
      .where(eq(schema.conversations.conversationId, input.conversationId))
      .limit(1);
    const conversation = conversations[0];
    if (!conversation) return { status: "conversation_not_found" };

    const [currentProfile] = await transaction
      .select()
      .from(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, conversation.contactId))
      .limit(1);
    if (!currentProfile) return { status: "conversation_not_found" };
    const changesAlias = Object.hasOwn(input.patch, "sharedAlias");
    const nextAlias = input.patch.sharedAlias?.trim() || null;

    const updated = await transaction
      .update(schema.contactProfiles)
      .set({
        ...input.patch,
        ...(changesAlias
          ? {
              sharedAlias: nextAlias,
              aliasUpdatedByUserId: input.actorUserId,
              aliasUpdatedAt: new Date(),
            }
          : {}),
        updatedByUserId: input.actorUserId,
        updatedAt: new Date(),
      })
      .where(eq(schema.contactProfiles.contactId, conversation.contactId))
      .returning();
    const profile = updated[0];
    if (!profile) {
      throw new Error(
        `contact profile ${conversation.contactId} does not exist`,
      );
    }

    if (changesAlias && currentProfile.sharedAlias !== nextAlias) {
      await transaction.insert(schema.contactAliasEvents).values({
        eventId: randomUUID(),
        contactId: profile.contactId,
        actorUserId: input.actorUserId,
        previousAlias: currentProfile.sharedAlias,
        nextAlias,
      });
    }

    if (input.patch.agentEnabled === false) {
      await new AgentTurnService(transaction).suppressPolicyForConversation(
        input.conversationId,
        "agent_disabled",
      );
      await transaction
        .update(schema.messages)
        .set({
          sendState: "cancelled_policy",
          sendError: "agent_disabled",
          sendUpdatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.messages.conversationId, input.conversationId),
            eq(schema.messages.actorType, "agent"),
            eq(schema.messages.sendState, "pending"),
          ),
        );
    }

    await transaction.insert(schema.auditEvents).values({
      auditId: randomUUID(),
      actorUserId: input.actorUserId,
      eventType: "contact_profile.updated",
      subjectType: "contact_profile",
      subjectId: profile.contactId,
      sourceIp: input.sourceIp,
      metadata: {
        conversationId: input.conversationId,
        changedFields: Object.keys(input.patch).sort().join(","),
      },
    });
    return { status: "ok", profile };
  });
}

/** 检查会话关联的联系人是否启用了 Agent 自动回复 */
export async function isConversationAgentEnabled(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
): Promise<boolean> {
  const profiles = await db
    .select({ agentEnabled: schema.contactProfiles.agentEnabled })
    .from(schema.conversations)
    .innerJoin(
      schema.contactProfiles,
      eq(schema.contactProfiles.contactId, schema.conversations.contactId),
    )
    .where(eq(schema.conversations.conversationId, conversationId))
    .limit(1);
  return profiles[0]?.agentEnabled ?? false;
}

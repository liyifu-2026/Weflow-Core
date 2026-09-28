/**
 * 媒体补建 Turn 的准入守卫（图片描述/语音转写完成后共用的单一事实源）。
 *
 * 媒体派生完成时的补轮此前只查 Execution Profile——全局 Kill Switch、
 * Handoff、联系人开关/拉黑都不在检查内，靠执行期闸门兜底会白白烧一次
 * 上下文装配与模型调用（live 实测全局关闸后媒体轮照跑照回）。这里在
 * 建轮前一次性复检全部准入条件。
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { isAgentPaused } from "../../handoff/application/handoff-service.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";
import { resolveExecutionProfileForAdmission } from "../../agent/application/execution-profile-service.js";

export type MediaTurnAdmission =
  | { allowed: true; executionProfileId: string }
  | { allowed: false; reason: string };

export async function resolveMediaTurnAdmission(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
): Promise<MediaTurnAdmission> {
  if (await isAgentPaused(db, conversationId)) {
    return { allowed: false, reason: "handoff_active" };
  }
  const runtime = await readRuntimeSettings(db, undefined, { fresh: true });
  if (!runtime.agentEnabled) {
    return { allowed: false, reason: "agent_disabled" };
  }
  const [contact] = await db
    .select({
      contactId: schema.contactProfiles.contactId,
      agentEnabled: schema.contactProfiles.agentEnabled,
      blocked: schema.contactProfiles.blocked,
    })
    .from(schema.conversations)
    .innerJoin(
      schema.contactProfiles,
      eq(schema.contactProfiles.contactId, schema.conversations.contactId),
    )
    .where(eq(schema.conversations.conversationId, conversationId))
    .limit(1);
  if (!contact?.agentEnabled || contact.blocked) {
    return { allowed: false, reason: "agent_disabled" };
  }
  const admission = await resolveExecutionProfileForAdmission(db);
  if (!admission.allowed) {
    return { allowed: false, reason: "profile_unavailable" };
  }
  return { allowed: true, executionProfileId: admission.profile.profileId };
}


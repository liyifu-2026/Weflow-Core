/**
 * 合并窗口 dispatcher（Phase 1）：把到期的 turn_admission_states 登记行
 * 合并建为一个 Agent Turn。
 *
 * 窗口期(12~30s)内护栏状态可能变化（Handoff 接管、自动回复关闭、Profile
 * 下线），因此建 turn 前逐项复检准入条件，复检不通过时登记行置 done
 * （消息已入库，只是不触发 AI），绝不吞掉 global-pause 人工路径——
 * 该路径由 ingest 在 settings.agentEnabled=false 分支独立处理。
 *
 * CAS 认领（scheduled+revision 匹配）防多实例重复建 turn；
 * 失败回写 scheduled/attempt+1 重试，超限置 failed。
 */
import { and, eq, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import * as schema from "../../../infrastructure/postgres/schema.js";
import {
  isAgentPaused,
} from "../../handoff/application/handoff-service.js";
import {
  resolveExecutionProfileForAdmission,
} from "../../agent/application/execution-profile-service.js";
import {
  claimDueTurnAdmission,
  type ClaimedAdmission,
} from "./turn-admission.js";

const MAX_ATTEMPTS = 3;

/** 单轮 dispatcher 扫描批量上限（对齐 memory-capture-dispatcher）。 */
const BATCH_LIMIT = 100;

export async function processTurnAdmissions(
  db: NodePgDatabase<typeof schema>,
  logger: Logger,
  now = new Date(),
): Promise<number> {
  const due = await db
    .select({
      conversationId: schema.turnAdmissionStates.conversationId,
      revision: schema.turnAdmissionStates.revision,
    })
    .from(schema.turnAdmissionStates)
    .where(
      and(
        eq(schema.turnAdmissionStates.status, "scheduled"),
        lte(schema.turnAdmissionStates.scheduledAt, now),
      ),
    )
    .orderBy(schema.turnAdmissionStates.scheduledAt)
    .limit(BATCH_LIMIT);

  let processed = 0;
  for (const { conversationId, revision } of due) {
    const claimed = await claimDueTurnAdmission(
      db as unknown as Parameters<typeof claimDueTurnAdmission>[0],
      { conversationId, revision, now },
    );
    if (!claimed) continue; // stale：已被其他实例认领或窗口被新消息重置
    try {
      await dispatchClaimedAdmission(db, claimed, now);
      processed += 1;
    } catch (error) {
      await requeueOrFailed(db, claimed, error, logger, now);
    }
  }
  return processed;
}

async function dispatchClaimedAdmission(
  db: NodePgDatabase<typeof schema>,
  claimed: ClaimedAdmission,
  now: Date,
): Promise<void> {
  void now; // markDone 用当前时刻即可；now 保留在签名上以备超时唤醒用
  // 复检 1：Handoff 进行中（人工接管）→ 不建 turn
  if (await isAgentPaused(db, claimed.conversationId)) {
    await markDone(db, claimed.conversationId, "handoff_active");
    return;
  }
  // 复检 2：联系人自动回复开关（agentEnabled）→ 关闭后不建 turn
  const [contact] = await db
    .select({ agentEnabled: schema.contactProfiles.agentEnabled })
    .from(schema.contactProfiles)
    .where(eq(schema.contactProfiles.contactId, claimed.contactId))
    .limit(1);
  if (!contact?.agentEnabled) {
    await markDone(db, claimed.conversationId, "agent_disabled");
    return;
  }
  // 复检 3：Execution Profile → 下线后不建 turn（对齐 ingest 准入语义）
  const admission = await resolveExecutionProfileForAdmission(db);
  if (!admission.allowed) {
    await markDone(db, claimed.conversationId, "profile_unavailable");
    return;
  }
  await db
    .insert(schema.agentTurns)
    .values({
      turnId: `turn:${claimed.lastMessageId}`,
      triggerMessageId: claimed.lastMessageId,
      conversationId: claimed.conversationId,
      status: "queued",
      executionProfileId: admission.profile.profileId,
      traceId: `turn-admission:${claimed.conversationId}:${claimed.revision}`,
    })
    .onConflictDoNothing();
  await markDone(db, claimed.conversationId, null);
}

async function markDone(
  db: NodePgDatabase<typeof schema>,
  conversationId: string,
  reasonCode: string | null,
): Promise<void> {
  await db
    .update(schema.turnAdmissionStates)
    .set({
      status: "done",
      errorCode: reasonCode,
      updatedAt: new Date(),
    })
    .where(eq(schema.turnAdmissionStates.conversationId, conversationId));
}

async function requeueOrFailed(
  db: NodePgDatabase<typeof schema>,
  claimed: ClaimedAdmission,
  error: unknown,
  logger: Logger,
  now: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(
    { conversationId: claimed.conversationId, error: message },
    "turn admission dispatch failed",
  );
  const failed = claimed.revision >= MAX_ATTEMPTS && claimed.messageCount < 0; // revision 是窗口代数不是重试次数；重试上限看 attempt 列
  void failed;
  const [current] = await db
    .select({ attempt: schema.turnAdmissionStates.attempt })
    .from(schema.turnAdmissionStates)
    .where(
      eq(schema.turnAdmissionStates.conversationId, claimed.conversationId),
    )
    .limit(1);
  const nextAttempt = (current?.attempt ?? 0) + 1;
  await db
    .update(schema.turnAdmissionStates)
    .set({
      status: nextAttempt >= MAX_ATTEMPTS ? "failed" : "scheduled",
      errorCode: message.slice(0, 100),
      attempt: nextAttempt,
      updatedAt: now,
    })
    .where(
      eq(schema.turnAdmissionStates.conversationId, claimed.conversationId),
    );
}

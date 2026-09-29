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
import { and, desc, eq, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { isAgentPaused } from "../../handoff/application/handoff-service.js";
import { readRuntimeSettings } from "../../operations/application/runtime-settings.js";
import { resolveExecutionProfileForAdmission } from "../../agent/application/execution-profile-service.js";
import {
  claimDueTurnAdmission,
  halfSentenceRescheduleDelayMs,
  type ClaimedAdmission,
} from "./turn-admission.js";
import {
  judgeMessageFinished,
  type DecisionSettings,
} from "../../agent/application/decision-triage.js";
import type { DecisionModelEndpoint } from "../../../infrastructure/model_runtime/decision-model-client.js";

const MAX_ATTEMPTS = 3;

/** 单轮 dispatcher 扫描批量上限（对齐 memory-capture-dispatcher）。 */
const BATCH_LIMIT = 100;

export async function processTurnAdmissions(
  db: NodePgDatabase<typeof schema>,
  logger: Logger,
  now = new Date(),
  /** Phase 4 半句判定依赖：未注入或开关关闭 = 到期即建轮（原行为） */
  halfSentence?: {
    endpoint: DecisionModelEndpoint;
    settings: DecisionSettings;
    /** 续窗时长（毫秒）；组合根按 decision.quietWindowMs 传入 */
    extensionMs: number;
  },
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
    const claimed = await claimDueTurnAdmission(db, {
      conversationId,
      revision,
      now,
    });
    if (!claimed) continue; // stale：已被其他实例认领或窗口被新消息重置
    try {
      await dispatchClaimedAdmission(db, claimed, logger, halfSentence);
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
  logger: Logger,
  halfSentence?: {
    endpoint: DecisionModelEndpoint;
    settings: DecisionSettings;
    extensionMs: number;
  },
): Promise<void> {
  // 复检 1：Handoff 进行中（人工接管）→ 不建 turn
  if (await isAgentPaused(db, claimed.conversationId)) {
    await markDone(db, claimed, "handoff_active");
    return;
  }
  // 复检 2：联系人自动回复开关（agentEnabled）与拉黑 → 关闭后不建 turn
  const [contact] = await db
    .select({
      agentEnabled: schema.contactProfiles.agentEnabled,
      blocked: schema.contactProfiles.blocked,
    })
    .from(schema.contactProfiles)
    .where(eq(schema.contactProfiles.contactId, claimed.contactId))
    .limit(1);
  if (!contact?.agentEnabled || contact.blocked) {
    await markDone(db, claimed, "agent_disabled");
    return;
  }
  // 复检 2.5：全局 Agent 开关（Kill Switch）——窗口开启期间被关闭的
  // 会话不能因「翻转发生在准入之后」而照常建轮（对齐 ingest 准入语义）
  const runtime = await readRuntimeSettings(db, logger, { fresh: true });
  if (!runtime.agentEnabled) {
    await markDone(db, claimed, "agent_disabled");
    return;
  }
  // 复检 3：Execution Profile → 下线后不建 turn（对齐 ingest 准入语义）
  const admission = await resolveExecutionProfileForAdmission(db);
  if (!admission.allowed) {
    await markDone(db, claimed, "profile_unavailable");
    return;
  }
  // Phase 4 半句判定：短窗到期后问决策模型「说完了吗」——未说完且未超
  // 续窗次数 → 续窗再等；说完/判定不可用/超次数 → 照常建轮（fail-open）。
  if (halfSentence && halfSentence.settings.halfSentenceEnabled) {
    const recent = await db
      .select({ text: schema.messages.text })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, claimed.conversationId),
          eq(schema.messages.direction, "inbound"),
        ),
      )
      .orderBy(desc(schema.messages.occurredAt))
      .limit(8);
    const verdict = await judgeMessageFinished({
      endpoint: halfSentence.endpoint,
      settings: halfSentence.settings,
      messages: recent.map((row) => row.text),
    });
    if (verdict === "unfinished") {
      const delayMs = halfSentenceRescheduleDelayMs(
        claimed.attempt,
        halfSentence.extensionMs,
      );
      if (delayMs !== null) {
        await db
          .update(schema.turnAdmissionStates)
          .set({
            status: "scheduled",
            scheduledAt: new Date(Date.now() + delayMs),
            attempt: claimed.attempt + 1,
            errorCode: "half_sentence_extended",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(
                schema.turnAdmissionStates.conversationId,
                claimed.conversationId,
              ),
              eq(schema.turnAdmissionStates.revision, claimed.revision),
              eq(schema.turnAdmissionStates.status, "dispatching"),
            ),
          );
        return;
      }
    }
  }
  await db
    .insert(schema.agentTurns)
    .values({
      turnId: `turn:${claimed.lastMessageId}`,
      triggerMessageId: claimed.lastMessageId,
      conversationId: claimed.conversationId,
      status: "queued",
      executionProfileId: admission.profile.profileId,
      traceId: `turn-admission:${claimed.conversationId}:${String(claimed.revision)}`,
    })
    .onConflictDoNothing();
  await markDone(db, claimed, null);
}

async function markDone(
  db: NodePgDatabase<typeof schema>,
  claimed: ClaimedAdmission,
  reasonCode: string | null,
): Promise<void> {
  // revision+dispatching 双守卫：认领后新客户消息会 upsert 重置窗口
  // （scheduled、revision+1）——此时本窗口已被接管，绝不能把它抹成 done
  // （否则新消息永远不建轮）。
  await db
    .update(schema.turnAdmissionStates)
    .set({
      status: "done",
      errorCode: reasonCode,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.turnAdmissionStates.conversationId, claimed.conversationId),
        eq(schema.turnAdmissionStates.revision, claimed.revision),
        eq(schema.turnAdmissionStates.status, "dispatching"),
      ),
    );
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
  // 重试上限看 attempt 列（revision 是窗口代数不是重试次数）
  const nextAttempt = claimed.attempt + 1;
  await db
    .update(schema.turnAdmissionStates)
    .set({
      status: nextAttempt >= MAX_ATTEMPTS ? "failed" : "scheduled",
      errorCode: message.slice(0, 100),
      attempt: nextAttempt,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.turnAdmissionStates.conversationId, claimed.conversationId),
        eq(schema.turnAdmissionStates.revision, claimed.revision),
        eq(schema.turnAdmissionStates.status, "dispatching"),
      ),
    );
}

/**
 * 媒体处理分发器
 * 从 PostgreSQL 读取待处理的媒体资产，推入 Redis 队列
 * 处理状态：processing_queued（已排队）、processing（处理中）
 * 支持指数退避重试（最多3次）
 *
 * P0 稳定性职责（Phase 2：修复图片消息静默死亡）：
 * - 视觉能力未配置时，将图片视觉阶段媒体短路标记为失败（vision_not_configured），
 *   避免图片消息在无 Worker 的情况下永久排队
 * - 视觉阶段停滞媒体超时恢复（stale_timeout），覆盖 Worker 死亡等场景
 * - 为 terminal failed 的媒体自动创建"降级 Turn"（无图片描述），
 *   保证任何客户消息都不会无声消失
 */
import { and, asc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import type { Logger } from "pino";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../postgres/schema.js";
import { createJobQueue, type JobEnvelope } from "./job-queue.js";
import { resolveExecutionProfileForAdmission } from "../../modules/agent/application/execution-profile-service.js";

/**
 * 分发器依赖的业务操作：由组合根（apps/api）注入，
 * 避免 infrastructure 层反向依赖 modules 层。
 */
export type MediaDispatcherDependencies = {
  /** 读取运行时开关（返回结构为 RuntimeSettings 的超集时兼容） */
  readSettings: (db: NodePgDatabase<typeof schema>) => Promise<{
    agentEnabled: boolean;
    visionEnabled: boolean;
  }>;
  /** 把被运营关闭视觉的媒体幂等路由到人工路径 */
  routeToHuman: (input: {
    messageId: string;
    conversationId: string;
  }) => Promise<void>;
};

/** 媒体处理队列名称 */
export const MEDIA_PROCESSING_QUEUE = "media-processing";

/** 视觉阶段状态：进入该状态后只依赖 Ingestion Worker 的视觉能力 */
const VISION_STAGE_STATUSES = ["processing_queued", "processing"] as const;

/** 视觉阶段停滞阈值：超过该时长未完成即视为卡死 */
const STALE_AFTER_MS = 15 * 60_000;

/** 降级 Turn 每次扫描批量上限 */
const DEGRADED_TURN_BATCH = 50;
const ACTIVE_MEDIA_STATUSES = [
  "queued",
  "downloading",
  "processing_queued",
  "processing",
] as const;

/**
 * Voice was part of the historical media pipeline, but the formal Channel
 * seam currently guarantees text and image only. Mark legacy voice rows as a
 * terminal, auditable outcome instead of leaving them in a fake pending state.
 */
export async function failUnsupportedLegacyVoiceMedia(
  db: NodePgDatabase<typeof schema>,
  logger: Logger,
): Promise<number> {
  const rows = await db
    .update(schema.mediaAssets)
    .set({
      status: "failed",
      errorCode: "legacy_voice_unsupported",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.mediaAssets.kind, "voice"),
        inArray(schema.mediaAssets.status, ACTIVE_MEDIA_STATUSES),
      ),
    )
    .returning({ mediaId: schema.mediaAssets.mediaId });
  if (rows.length > 0) {
    logger.warn(
      { count: rows.length },
      "Legacy voice media marked unavailable",
    );
  }
  return rows.length;
}

/**
 * 多模态能力未配置时：把图片处理阶段媒体标记为失败。
 * 注意只处理 processing_queued/processing（处理阶段）；
 * queued/downloading（历史通道下载阶段）保留，人工仍可查看文件。
 */
export async function failMediaWithoutVision(
  db: NodePgDatabase<typeof schema>,
  logger: Logger,
): Promise<number> {
  const rows = await db
    .update(schema.mediaAssets)
    .set({
      status: "failed",
      errorCode: "vision_not_configured",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.mediaAssets.kind, "image"),
        inArray(schema.mediaAssets.status, VISION_STAGE_STATUSES),
      ),
    )
    .returning({ mediaId: schema.mediaAssets.mediaId });
  if (rows.length > 0) {
    logger.warn({ count: rows.length }, "Media failed: vision not configured");
  }
  return rows.length;
}

/**
 * 停滞媒体超时恢复：processing 状态超过阈值仍未完成 → 标记失败。
 * 只恢复 processing：processing_queued 是正常排队（模型并发=1 时积压合法），
 * 队列投递由 dispatcher 持续进行；worker 死亡只会在 processing 留下悬挂。
 */
export async function recoverStaleMedia(
  db: NodePgDatabase<typeof schema>,
  logger: Logger,
  staleAfterMs: number = STALE_AFTER_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const rows = await db
    .update(schema.mediaAssets)
    .set({
      status: "failed",
      errorCode: "stale_timeout",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.mediaAssets.status, "processing"),
        lt(schema.mediaAssets.updatedAt, cutoff),
      ),
    )
    .returning({ mediaId: schema.mediaAssets.mediaId });
  if (rows.length > 0) {
    logger.warn({ count: rows.length }, "Media failed: stale timeout");
  }
  return rows.length;
}

/**
 * 视觉能力被运营关闭（vision_enabled=false）时：视觉阶段媒体标记失败，
 * 且图片消息幂等进入人工路径（一次通知，不洪泛）——图片不静默、也不交给 Agent。
 */
export async function failMediaVisionDisabled(
  db: NodePgDatabase<typeof schema>,
  logger: Logger,
  routeToHuman: MediaDispatcherDependencies["routeToHuman"],
): Promise<number> {
  const rows = await db
    .update(schema.mediaAssets)
    .set({
      status: "failed",
      errorCode: "vision_disabled",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.mediaAssets.kind, "image"),
        inArray(schema.mediaAssets.status, VISION_STAGE_STATUSES),
      ),
    )
    .returning({
      mediaId: schema.mediaAssets.mediaId,
      messageId: schema.mediaAssets.messageId,
      conversationId: schema.mediaAssets.conversationId,
    });
  if (rows.length > 0) {
    logger.warn(
      { count: rows.length },
      "Media failed: vision disabled by operator",
    );
    for (const media of rows) {
      await routeToHuman(media);
    }
  }
  return rows.length;
}

/**
 * 为 terminal failed 的媒体创建"降级 Turn"（无图片描述）。
 * 镜像 ingest 的建 Turn 条件：会话非人工接管（agentPaused=false 或未开始）
 * 且联系人 agentEnabled；幂等：同一消息已有 Turn 则跳过。
 * 运营关闭视觉（vision_disabled）的媒体不走降级 Turn（已进人工路径）。
 */
export async function createDegradedTurns(
  db: NodePgDatabase<typeof schema>,
  logger: Logger,
  readSettings: MediaDispatcherDependencies["readSettings"],
): Promise<number> {
  // 全局 Agent 关闭时不再创建任何 Turn（消息已由 ingest 路由到人工路径）
  const runtime = await readSettings(db);
  if (!runtime.agentEnabled) return 0;
  const candidates = await db
    .select({
      mediaId: schema.mediaAssets.mediaId,
      messageId: schema.mediaAssets.messageId,
      conversationId: schema.mediaAssets.conversationId,
      agentPaused: schema.handoffStates.agentPaused,
      agentEnabled: schema.contactProfiles.agentEnabled,
    })
    .from(schema.mediaAssets)
    .leftJoin(
      schema.agentTurns,
      eq(schema.agentTurns.triggerMessageId, schema.mediaAssets.messageId),
    )
    .leftJoin(
      schema.handoffStates,
      eq(
        schema.handoffStates.conversationId,
        schema.mediaAssets.conversationId,
      ),
    )
    .innerJoin(
      schema.conversations,
      eq(
        schema.conversations.conversationId,
        schema.mediaAssets.conversationId,
      ),
    )
    .innerJoin(
      schema.contactProfiles,
      eq(schema.contactProfiles.contactId, schema.conversations.contactId),
    )
    .where(
      and(
        eq(schema.mediaAssets.status, "failed"),
        // errorCode 为 NULL（历史数据/未设错误码的失败路径）不视为 vision_disabled，
        // 仍应生成降级 Turn，避免 failed 媒体静默（SQL 中 NULL <> 'x' 结果为 NULL）
        or(
          isNull(schema.mediaAssets.errorCode),
          ne(schema.mediaAssets.errorCode, "vision_disabled"),
        ),
        or(
          isNull(schema.mediaAssets.errorCode),
          ne(schema.mediaAssets.errorCode, "legacy_voice_unsupported"),
        ),
        isNull(schema.agentTurns.turnId),
      ),
    )
    .limit(DEGRADED_TURN_BATCH);

  const seen = new Set<string>();
  const eligible = candidates.filter((candidate) => {
    if (seen.has(candidate.messageId)) return false;
    seen.add(candidate.messageId);
    return candidate.agentEnabled && !candidate.agentPaused;
  });
  if (eligible.length === 0) return 0;

  const admission = await resolveExecutionProfileForAdmission(db);
  if (!admission.allowed) return 0;

  let created = 0;
  for (const candidate of eligible) {
    const inserted = await db
      .insert(schema.agentTurns)
      .values({
        turnId: `turn:${candidate.messageId}`,
        triggerMessageId: candidate.messageId,
        conversationId: candidate.conversationId,
        status: "queued",
        executionProfileId: admission.profile.profileId,
        traceId: `media:${candidate.mediaId}`,
      })
      .onConflictDoNothing()
      .returning({ turnId: schema.agentTurns.turnId });
    created += inserted.length;
  }
  if (created > 0) {
    logger.warn({ created }, "Degraded turns created for failed media");
  }
  return created;
}

/** 启动媒体处理分发器 */
export function startMediaProcessingDispatcher(options: {
  db: NodePgDatabase<typeof schema>;
  redisUrl: string;
  logger: Logger;
  visionConfigured: boolean;
  dependencies: MediaDispatcherDependencies;
}): () => void {
  const { dependencies } = options;
  const queue = createJobQueue(MEDIA_PROCESSING_QUEUE, options.redisUrl);
  const abortController = new AbortController();
  // 记录上一次 visionEnabled 状态：短路处理只在状态翻转时执行一次，
  // 避免开关关闭期间每秒全表扫描 + 逐条转人工的空转
  let visionEnabledBefore: boolean | undefined;
  const run = async () => {
    while (!abortController.signal.aborted) {
      try {
        // vision_enabled=false（运营关闭）优先于配置探测：
        // 图片进人工路径；未配置但未关闭 → 短路失败 + 降级 Turn
        const runtime = await dependencies.readSettings(options.db);
        await failUnsupportedLegacyVoiceMedia(options.db, options.logger);
        if (!runtime.visionEnabled) {
          if (visionEnabledBefore !== false) {
            await failMediaVisionDisabled(
              options.db,
              options.logger,
              dependencies.routeToHuman,
            );
          }
        } else if (options.visionConfigured) {
          const assets = await options.db
            .select()
            .from(schema.mediaAssets)
            .where(inArray(schema.mediaAssets.status, VISION_STAGE_STATUSES))
            .orderBy(asc(schema.mediaAssets.createdAt))
            .limit(100);
          for (const asset of assets) {
            // 正式 Channel 当前只承诺图片视觉处理；语音已延期。
            if (asset.kind !== "image") continue;
            const jobType = "media.describe_image";
            const envelope: JobEnvelope = {
              jobId: `media_${asset.mediaId.replace(/^media:/, "")}`,
              jobType,
              ownerModule: "media",
              businessEntityId: asset.mediaId,
              idempotencyKey: asset.mediaId,
              attempt: asset.attempt,
              traceId: `media:${asset.mediaId}`,
              createdAt: asset.createdAt.toISOString(),
            };
            await queue.add(jobType, envelope, {
              jobId: envelope.jobId,
              attempts: 3,
              backoff: { type: "exponential", delay: 2_000 },
            });
          }
        } else {
          // 无视觉能力：短路失败，避免图片消息永久排队
          await failMediaWithoutVision(options.db, options.logger);
        }
        visionEnabledBefore = runtime.visionEnabled;
        // 停滞恢复 + 降级 Turn（两种情况都执行）
        await recoverStaleMedia(options.db, options.logger);
        await createDegradedTurns(
          options.db,
          options.logger,
          dependencies.readSettings,
        );
      } catch (error) {
        options.logger.error({ err: error }, "Media dispatch failed");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        abortController.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  };
  void run();
  return () => {
    abortController.abort();
    void queue.close();
  };
}

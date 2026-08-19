/**
 * 媒体视觉能力关闭时把媒体消息幂等路由到人工路径。
 *
 * 从 media-processing-dispatcher 迁出：infrastructure 层不得反向依赖
 * modules 层，handoff 业务逻辑归属 handoff 模块，由组合根注入回 dispatcher。
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { createHandoff } from "./handoff-service.js";

/** 幂等路由媒体消息到人工路径（会话已在人工周期则跳过） */
export async function routeMediaToHuman(
  db: NodePgDatabase<typeof schema>,
  logger: Logger,
  media: {
    messageId: string;
    conversationId: string;
  },
): Promise<void> {
  const handoff = await db
    .select({ agentPaused: schema.handoffStates.agentPaused })
    .from(schema.handoffStates)
    .where(eq(schema.handoffStates.conversationId, media.conversationId))
    .limit(1);
  if (handoff[0]?.agentPaused) return;
  const result = await createHandoff(db, {
    conversationId: media.conversationId,
    actorUserId: "system",
    clientRequestId: `vision-disabled-${createHash("sha256")
      .update(media.messageId)
      .digest("hex")
      .slice(0, 20)}`,
    summary: "vision_disabled: media routed to human",
    sourceIp: "server2",
  });
  if (result.status !== "ok" && result.status !== "invalid_transition") {
    logger.warn(
      { status: result.status, conversationId: media.conversationId },
      "vision disabled handoff skipped",
    );
  }
}

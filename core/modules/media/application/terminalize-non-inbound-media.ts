/**
 * 非客户方向媒体的派生阶段终态化。
 *
 * 图片描述 / 语音转写只服务客户消息（inbound）；自消息回声（outbound）与
 * 方向未知的行在读消息方向时提前返回，且**从不落终态**——媒体于是永久停在
 * processing_queued。dispatcher 每轮都把 processing_queued 重新投递
 * （multi-modal 阶段状态是它唯一的筛选条件），于是同一批媒体每秒被投递一次：
 * 2026-09-20 X230 实测 3 张自消息图片空转数小时、日志刷屏、无谓的队列与
 * 数据库负载（recoverStaleMedia 只兜 processing，兜不住这种状态）。
 *
 * 终态语义与文件附件一致：已落盘即可查看（ready、无描述/转写、不建 Turn）。
 * 不写 errorCode：这不是失败，只是没有派生内容——ready + description 为空
 * 正是文件/视频附件的既有形态。
 */
import { and, eq, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";

export async function terminalizeNonInboundMedia(
  db: NodePgDatabase<typeof schema>,
  mediaId: string,
): Promise<void> {
  await db
    .update(schema.mediaAssets)
    .set({
      status: "ready",
      errorCode: null,
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.mediaAssets.mediaId, mediaId),
        ne(schema.mediaAssets.status, "ready"),
      ),
    );
}

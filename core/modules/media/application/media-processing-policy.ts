/**
 * 媒体处理调度策略
 * 定义媒体处理阶段的业务判定，供分发器等执行方引用：
 * - 哪些状态属于多模态处理阶段
 * - 处理阶段停滞多久视为卡死
 */

/** 多模态处理阶段状态：进入该状态后只依赖 Ingestion Worker 的处理能力 */
export const MULTIMODAL_STAGE_STATUSES = [
  "processing_queued",
  "processing",
] as const;

/** 处理阶段停滞阈值：超过该时长未完成即视为卡死 */
export const STALE_AFTER_MS = 15 * 60_000;

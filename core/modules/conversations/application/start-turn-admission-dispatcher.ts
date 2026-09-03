/**
 * 合并窗口 dispatcher 启动器（进程内轻量轮询，对齐 startMemoryMaintenance）。
 *
 * 处理循环 processTurnAdmissions 自带 CAS 认领与失败重试，多实例安全，
 * 因此无需经过 Redis 队列；本启动器只负责「定时驱动 + 优雅停止」。
 */
import type { Logger } from "pino";

export function startTurnAdmissionDispatcher(options: {
  process: (context: { signal: AbortSignal }) => Promise<number>;
  intervalMs?: number;
  logger?: Pick<Logger, "error" | "info">;
}): () => void {
  const intervalMs = options.intervalMs ?? 1_000;
  const abortController = new AbortController();
  const run = async (): Promise<void> => {
    while (!abortController.signal.aborted) {
      try {
        const processed = await options.process({
          signal: abortController.signal,
        });
        if (processed > 0) {
          options.logger?.info(
            { processed },
            "Turn admission dispatch processed windows",
          );
        }
      } catch (error) {
        options.logger?.error({ err: error }, "Turn admission dispatch failed");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
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
  };
}

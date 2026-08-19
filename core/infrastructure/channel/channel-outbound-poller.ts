import type { Logger } from "pino";

export type ChannelOutboundPollerOptions<Database> = {
  db: Database;
  intervalMs?: number;
  logger?: Pick<Logger, "error" | "info">;
  sendOutbound(db: Database): Promise<void>;
};

export async function pollChannelOutboundOnce<Database>(
  options: ChannelOutboundPollerOptions<Database>,
): Promise<void> {
  await options.sendOutbound(options.db);
}

export function startChannelOutboundPoller<Database>(
  options: ChannelOutboundPollerOptions<Database>,
): () => void {
  const abortController = new AbortController();
  const intervalMs = options.intervalMs ?? 1_000;

  const run = async (): Promise<void> => {
    while (!abortController.signal.aborted) {
      try {
        await pollChannelOutboundOnce(options);
      } catch (error) {
        options.logger?.error(
          { err: error },
          "Channel Host outbound cycle failed",
        );
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
  options.logger?.info("Channel Host outbound polling started");
  return () => {
    abortController.abort();
  };
}

import type { Logger } from "pino";

export type ChannelMediaPollerOptions<Database> = {
  db: Database;
  intervalMs?: number;
  logger?: Pick<Logger, "error" | "info">;
  syncMedia(db: Database): Promise<void>;
};

export async function pollChannelMediaOnce<Database>(
  options: ChannelMediaPollerOptions<Database>,
): Promise<void> {
  await options.syncMedia(options.db);
}

export function startChannelMediaPoller<Database>(
  options: ChannelMediaPollerOptions<Database>,
): () => void {
  const abortController = new AbortController();
  const intervalMs = options.intervalMs ?? 1_000;

  const run = async (): Promise<void> => {
    while (!abortController.signal.aborted) {
      try {
        await pollChannelMediaOnce(options);
      } catch (error) {
        options.logger?.error(
          { err: error },
          "Channel Host media cycle failed",
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
  options.logger?.info("Channel Host media polling started");
  return () => {
    abortController.abort();
  };
}

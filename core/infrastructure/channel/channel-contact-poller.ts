import type { Logger } from "pino";
import type { ChannelContactSource } from "../../modules/channel/contracts/channel-contact-source.js";

export type ChannelContactPollerOptions<Database> = {
  db: Database;
  source: ChannelContactSource;
  intervalMs?: number;
  logger?: Pick<Logger, "error" | "info">;
  syncContacts(db: Database, source: ChannelContactSource): Promise<number>;
};

export async function pollChannelContactsOnce<Database>(
  options: ChannelContactPollerOptions<Database>,
): Promise<number> {
  return options.syncContacts(options.db, options.source);
}

export function startChannelContactPoller<Database>(
  options: ChannelContactPollerOptions<Database>,
): () => void {
  const abortController = new AbortController();
  const intervalMs = options.intervalMs ?? 60_000;

  const run = async (): Promise<void> => {
    while (!abortController.signal.aborted) {
      try {
        await pollChannelContactsOnce(options);
      } catch (error) {
        options.logger?.error(
          { err: error },
          "Channel Host contact synchronization failed",
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
  options.logger?.info("Channel Host contact polling started");
  return () => {
    abortController.abort();
  };
}

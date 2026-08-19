import type { Logger } from "pino";
import type {
  ChannelEvent,
  ChannelEventSource,
} from "../../modules/channel/contracts/channel-event-source.js";

export type ChannelEventPollerDependencies<Database> = {
  currentCursor(db: Database): Promise<string>;
  ingestEvents(
    db: Database,
    events: ChannelEvent[],
    nextCursor: string,
  ): Promise<void>;
};

export type ChannelEventPollerOptions<Database> = {
  source: ChannelEventSource;
  db: Database;
  intervalMs?: number;
  logger?: Pick<Logger, "error" | "info">;
  dependencies: ChannelEventPollerDependencies<Database>;
};

export async function pollChannelEventsOnce<Database>(
  options: ChannelEventPollerOptions<Database>,
): Promise<void> {
  let cursor = await options.dependencies.currentCursor(options.db);
  let page = await options.source.pullEvents({
    afterCursor: cursor,
    limit: 100,
  });
  await options.dependencies.ingestEvents(
    options.db,
    [...page.events],
    page.nextCursor,
  );
  cursor = page.nextCursor;
  while (page.hasMore) {
    page = await options.source.pullEvents({ afterCursor: cursor, limit: 100 });
    await options.dependencies.ingestEvents(
      options.db,
      [...page.events],
      page.nextCursor,
    );
    cursor = page.nextCursor;
  }
}

export function startChannelEventPoller<Database>(
  options: ChannelEventPollerOptions<Database>,
): () => void {
  const abortController = new AbortController();
  const intervalMs = options.intervalMs ?? 1_000;

  const run = async (): Promise<void> => {
    while (!abortController.signal.aborted) {
      try {
        await pollChannelEventsOnce(options);
      } catch (error) {
        options.logger?.error(
          { err: error },
          "Channel Host polling cycle failed",
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
  options.logger?.info("Channel Host polling started");
  return () => {
    abortController.abort();
  };
}

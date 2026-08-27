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
  logger?: Pick<Logger, "error" | "info" | "warn">;
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
  // Self-heal: a Host ledger that was wiped/rebuilt restarts its numbering
  // below our checkpoint; pulling "after N" would then stall forever. When
  // the Host reports a maxCursor below the local cursor, replay from 0 —
  // ingestion is idempotent by eventId, so replaying is safe.
  if (page.maxCursor !== undefined && Number(page.maxCursor) < Number(cursor)) {
    options.logger?.warn(
      {
        localCursor: cursor,
        hostMaxCursor: page.maxCursor,
        ...(page.epoch !== undefined ? { hostEpoch: page.epoch } : {}),
      },
      "Channel Host cursor rewound below the local checkpoint; replaying from 0",
    );
    cursor = "0";
    page = await options.source.pullEvents({ afterCursor: "0", limit: 100 });
  }
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

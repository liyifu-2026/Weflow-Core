import { describe, expect, it, vi } from "vitest";
import type {
  ChannelEvent,
  ChannelEventSource,
} from "../modules/channel/contracts/channel-event-source.js";
import { pollChannelEventsOnce } from "../infrastructure/channel/channel-event-poller.js";

describe("Channel Host event poller", () => {
  it("passes the Host page into ingestion and uses the persisted checkpoint", async () => {
    const requests: string[] = [];
    let checkpoint = "4";
    const source: ChannelEventSource = {
      pullEvents: ({ afterCursor }) => {
        requests.push(afterCursor ?? "missing");
        return Promise.resolve({
          events: [
            {
              eventId: "channel:room-1:5",
              cursor: "5",
              conversationRef: "room-1",
              channelMessageId: "5",
              senderRef: "wxid-contact",
              kind: "text",
              content: "hello",
              occurredAt: "2026-08-17T00:00:00Z",
              observedAt: "2026-08-17T00:00:01Z",
              isSelf: false,
            },
          ],
          nextCursor: "5",
          hasMore: false,
        });
      },
    };
    const ingested: string[] = [];

    await pollChannelEventsOnce({
      source,
      db: {},
      dependencies: {
        currentCursor: () => Promise.resolve(checkpoint),
        ingestEvents: (_db, events, nextCursor) => {
          ingested.push(...events.map((event) => event.eventId));
          checkpoint = nextCursor;
          return Promise.resolve();
        },
      },
    });

    expect(requests).toEqual(["4"]);
    expect(ingested).toEqual(["channel:room-1:5"]);
    expect(checkpoint).toBe("5");
  });

  it("replays the same page after ingestion rolls back before advancing the cursor", async () => {
    const requests: string[] = [];
    let checkpoint = "0";
    let attempts = 0;
    const source: ChannelEventSource = {
      pullEvents: ({ afterCursor }) => {
        const cursor = afterCursor ?? "missing";
        requests.push(cursor);
        return Promise.resolve({
          events: [
            {
              eventId: "channel:room-rollback:1",
              cursor: "1",
              conversationRef: "room-rollback",
              channelMessageId: "1",
              senderRef: "wxid-contact",
              kind: "text",
              content: "retry me once",
              occurredAt: "2026-08-17T00:00:00Z",
              observedAt: "2026-08-17T00:00:01Z",
              isSelf: false,
            },
          ],
          nextCursor: "1",
          hasMore: false,
        });
      },
    };
    const ingested: string[] = [];

    const dependencies = {
      currentCursor: () => Promise.resolve(checkpoint),
      ingestEvents: (
        _db: object,
        events: ChannelEvent[],
        nextCursor: string,
      ) => {
        attempts += 1;
        ingested.push(...events.map((event) => event.eventId));
        if (attempts === 1) {
          return Promise.reject(new Error("simulated_transaction_rollback"));
        }
        checkpoint = nextCursor;
        return Promise.resolve();
      },
    };

    await expect(
      pollChannelEventsOnce({
        source,
        db: {},
        dependencies,
      }),
    ).rejects.toThrow("simulated_transaction_rollback");
    await pollChannelEventsOnce({ source, db: {}, dependencies });

    expect(requests).toEqual(["0", "0"]);
    expect(ingested).toEqual([
      "channel:room-rollback:1",
      "channel:room-rollback:1",
    ]);
    expect(checkpoint).toBe("1");
  });

  it("replays from 0 when the Host maxCursor rewinds below the local checkpoint", async () => {
    const requests: string[] = [];
    let checkpoint = "100";
    const source: ChannelEventSource = {
      pullEvents: ({ afterCursor }) => {
        const cursor = afterCursor ?? "missing";
        requests.push(cursor);
        if (cursor === "100") {
          // Ledger wiped and rebuilt: numbering restarted at 50, far below
          // the local checkpoint — the events after 100 will never come.
          return Promise.resolve({
            events: [],
            nextCursor: "100",
            hasMore: false,
            maxCursor: "50",
            epoch: "abc123",
          });
        }
        return Promise.resolve({
          events: [
            {
              eventId: "channel:room-rewind:51",
              cursor: "51",
              conversationRef: "room-rewind",
              channelMessageId: "51",
              senderRef: "wxid-contact",
              kind: "text",
              content: "post-rewind message",
              occurredAt: "2026-08-17T00:00:00Z",
              observedAt: "2026-08-17T00:00:01Z",
              isSelf: false,
            },
          ],
          nextCursor: "51",
          hasMore: false,
          maxCursor: "51",
          epoch: "abc123",
        });
      },
    };
    const ingested: string[] = [];
    const warn = vi.fn();

    await pollChannelEventsOnce({
      source,
      db: {},
      logger: { warn, error: vi.fn(), info: vi.fn() },
      dependencies: {
        currentCursor: () => Promise.resolve(checkpoint),
        ingestEvents: (_db, events, nextCursor) => {
          ingested.push(...events.map((event) => event.eventId));
          checkpoint = nextCursor;
          return Promise.resolve();
        },
      },
    });

    expect(requests).toEqual(["100", "0"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ localCursor: "100", hostMaxCursor: "50" }),
      expect.stringContaining("rewound"),
    );
    expect(ingested).toEqual(["channel:room-rewind:51"]);
    expect(checkpoint).toBe("51");
  });

  it("leaves behaviour unchanged when the Host omits maxCursor", async () => {
    const requests: string[] = [];
    let checkpoint = "100";
    const source: ChannelEventSource = {
      pullEvents: ({ afterCursor }) => {
        const cursor = afterCursor ?? "missing";
        requests.push(cursor);
        return Promise.resolve({
          events: [],
          nextCursor: "100",
          hasMore: false,
        });
      },
    };
    const warn = vi.fn();

    await pollChannelEventsOnce({
      source,
      db: {},
      logger: { warn, error: vi.fn(), info: vi.fn() },
      dependencies: {
        currentCursor: () => Promise.resolve(checkpoint),
        ingestEvents: (_db, _events, nextCursor) => {
          checkpoint = nextCursor;
          return Promise.resolve();
        },
      },
    });

    expect(requests).toEqual(["100"]);
    expect(warn).not.toHaveBeenCalled();
    expect(checkpoint).toBe("100");
  });

  it("does not replay when the Host maxCursor is at or above the checkpoint", async () => {
    const requests: string[] = [];
    let checkpoint = "4";
    const source: ChannelEventSource = {
      pullEvents: ({ afterCursor }) => {
        const cursor = afterCursor ?? "missing";
        requests.push(cursor);
        return Promise.resolve({
          events: [],
          nextCursor: "4",
          hasMore: false,
          maxCursor: "50",
        });
      },
    };
    const warn = vi.fn();

    await pollChannelEventsOnce({
      source,
      db: {},
      logger: { warn, error: vi.fn(), info: vi.fn() },
      dependencies: {
        currentCursor: () => Promise.resolve(checkpoint),
        ingestEvents: (_db, _events, nextCursor) => {
          checkpoint = nextCursor;
          return Promise.resolve();
        },
      },
    });

    expect(requests).toEqual(["4"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

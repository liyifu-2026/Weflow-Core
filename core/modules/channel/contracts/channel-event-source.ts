/**
 * Channel events contract — authoritative definition lives in
 * `@weflow/contracts` (`src/channel.ts`). This shim keeps existing Core
 * import paths stable; do not add new types here.
 */
export type {
  ChannelEvent,
  ChannelEventsPage,
  PullChannelEventsInput,
  ChannelEventSource,
} from "@weflow-leaif/contracts";

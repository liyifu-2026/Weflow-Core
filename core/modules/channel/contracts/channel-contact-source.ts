/**
 * Channel contacts contract — authoritative definition lives in
 * `@weflow/contracts` (`src/channel.ts`). This shim keeps existing Core
 * import paths stable; do not add new types here.
 */
export type {
  ChannelContact,
  ChannelContactsPage,
  ChannelContactSource,
} from "@weflow/contracts";

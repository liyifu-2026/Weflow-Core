import { capability } from "../kernel/index.js";
import type { ChannelEventSource } from "../../../modules/channel/contracts/channel-event-source.js";

export const CHANNEL_EVENTS_CAPABILITY =
  capability<ChannelEventSource>("channel.events");

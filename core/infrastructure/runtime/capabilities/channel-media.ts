import { capability } from "../kernel/index.js";
import type { ChannelMediaSource } from "../../../modules/channel/contracts/channel-media-source.js";

export const CHANNEL_MEDIA_CAPABILITY =
  capability<ChannelMediaSource>("channel.media");

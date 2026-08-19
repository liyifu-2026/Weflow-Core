import { capability } from "../kernel/index.js";
import type { ChannelSendOperations } from "../../../modules/channel/contracts/channel-send-operations.js";

export const CHANNEL_SEND_CAPABILITY =
  capability<ChannelSendOperations>("channel.send");

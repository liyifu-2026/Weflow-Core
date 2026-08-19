import { capability } from "../kernel/index.js";
import type { ChannelContactSource } from "../../../modules/channel/contracts/channel-contact-source.js";

export const CHANNEL_CONTACTS_CAPABILITY =
  capability<ChannelContactSource>("channel.contacts");

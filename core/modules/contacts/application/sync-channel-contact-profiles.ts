/**
 * 渠道联系人资料同步模块
 * 从 Channel Host 拉取联系人列表并更新本地联系人资料（昵称、备注、别名等）。
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { contactProfiles } from "../../../infrastructure/postgres/schema.js";
import type { ChannelContactSource } from "../../channel/contracts/channel-contact-source.js";
import { contactIdForChannel } from "./contact-profile-service.js";

const PAGE_SIZE = 100;
const MAX_CONTACTS = 10_000;
/** 平台通道标识（与 ingest-channel-events 保持一致） */
const CHANNEL_KIND = "channel";

/** 从 Channel Host 分页拉取联系人资料并同步到 Contact Profile，返回同步数量。 */
export async function syncChannelContactProfiles(
  db: NodePgDatabase<typeof schema>,
  source: ChannelContactSource,
): Promise<number> {
  let updated = 0;
  let afterCursor: string | undefined;
  for (let page = 0; page * PAGE_SIZE < MAX_CONTACTS; page += 1) {
    const result = await source.pullContacts({
      ...(afterCursor ? { afterCursor } : {}),
      limit: PAGE_SIZE,
    });
    for (const contact of result.contacts) {
      const now = new Date();
      const rows = await db
        .insert(contactProfiles)
        .values({
          contactId: contactIdForChannel(CHANNEL_KIND, contact.contactRef),
          channel: CHANNEL_KIND,
          channelContactId: contact.contactRef,
          channelDisplayName: contact.displayName,
          channelNickname: contact.nickname,
          channelRemark: contact.remark,
          channelAlias: contact.alias,
          avatarUrl: contact.avatarUrl,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [contactProfiles.channel, contactProfiles.channelContactId],
          set: {
            channelDisplayName: contact.displayName,
            channelNickname: contact.nickname,
            channelRemark: contact.remark,
            channelAlias: contact.alias,
            avatarUrl: contact.avatarUrl,
            updatedAt: now,
          },
        })
        .returning({ contactId: contactProfiles.contactId });
      updated += rows.length;
    }
    if (!result.hasMore) break;
    if (!result.nextCursor || result.nextCursor === afterCursor) {
      throw new Error("channel_contacts_cursor_did_not_advance");
    }
    afterCursor = result.nextCursor;
  }
  return updated;
}

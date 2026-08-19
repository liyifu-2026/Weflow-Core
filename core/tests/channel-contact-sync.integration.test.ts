import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import type { ChannelContactSource } from "../modules/channel/contracts/channel-contact-source.js";
import { contactIdForChannel } from "../modules/contacts/application/contact-profile-service.js";
import { syncChannelContactProfiles } from "../modules/contacts/application/sync-channel-contact-profiles.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Channel Host contact synchronization", () => {
  let postgres: Postgres;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const newContactRef = `wxid:new-${suffix}`;
  const existingContactRef = `wxid:existing-${suffix}`;
  const contactIds = [
    contactIdForChannel("channel", newContactRef),
    contactIdForChannel("channel", existingContactRef),
  ];

  beforeAll(() => {
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "channel-contact-sync-test"),
    );
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.contactProfiles)
      .where(inArray(schema.contactProfiles.contactId, contactIds));
    await postgres.close();
  });

  it("upserts profiles, preserves business fields, and advances opaque cursors", async () => {
    const existingContactId = contactIdForChannel(
      "channel",
      existingContactRef,
    );
    await postgres.db.insert(schema.contactProfiles).values({
      contactId: existingContactId,
      channel: "channel",
      channelContactId: existingContactRef,
      sharedAlias: "人工维护名称",
      tags: ["priority"],
      agentEnabled: false,
    });

    const requests: (string | null)[] = [];
    const source: ChannelContactSource = {
      pullContacts: ({ afterCursor }) => {
        requests.push(afterCursor ?? null);
        if (afterCursor === "opaque:page-1") {
          return Promise.resolve({
            contacts: [
              {
                contactRef: existingContactRef,
                displayName: "同步后的备注",
                nickname: "同步后的昵称",
                remark: "同步后的备注",
                alias: "synced-alias",
                avatarUrl: "https://avatar.example/synced",
                contactType: "contact",
              },
            ],
            nextCursor: "opaque:page-2",
            hasMore: false,
          });
        }
        return Promise.resolve({
          contacts: [
            {
              contactRef: newContactRef,
              displayName: "新联系人",
              nickname: "昵称",
              remark: null,
              alias: null,
              avatarUrl: null,
              contactType: "contact",
            },
          ],
          nextCursor: "opaque:page-1",
          hasMore: true,
        });
      },
    };

    await expect(syncChannelContactProfiles(postgres.db, source)).resolves.toBe(
      2,
    );
    expect(requests).toEqual([null, "opaque:page-1"]);

    const profiles = await postgres.db
      .select()
      .from(schema.contactProfiles)
      .where(inArray(schema.contactProfiles.contactId, contactIds));
    expect(profiles).toHaveLength(2);
    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contactId: contactIdForChannel("channel", newContactRef),
          channelDisplayName: "新联系人",
        }),
        expect.objectContaining({
          contactId: existingContactId,
          channelDisplayName: "同步后的备注",
          sharedAlias: "人工维护名称",
          tags: ["priority"],
          agentEnabled: false,
        }),
      ]),
    );
  });
});

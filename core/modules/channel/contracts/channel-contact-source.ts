/**
 * Formal Channel contacts seam.
 *
 * Contact references and cursors are opaque to Core. A provider may derive
 * them from a local database, a remote API, or another channel-specific
 * identity store, but Core only consumes the normalized profile fields.
 */
export type ChannelContact = {
  readonly contactRef: string;
  readonly displayName: string;
  readonly nickname: string | null;
  readonly remark: string | null;
  readonly alias: string | null;
  readonly avatarUrl: string | null;
  readonly contactType: string;
};

export type ChannelContactsPage = {
  readonly contacts: readonly ChannelContact[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
};

export interface ChannelContactSource {
  pullContacts(input: {
    afterCursor?: string;
    limit?: number;
  }): Promise<ChannelContactsPage>;
}

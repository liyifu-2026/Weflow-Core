import { describe, expect, it } from "vitest";
import { contactIdForChannel } from "../modules/contacts/application/contact-profile-service.js";
import { normalizeAccount } from "../modules/conversations/application/ingest-channel-events.js";
import type { ChannelEvent } from "../modules/channel/contracts/channel-event-source.js";

describe("ADR-0005 多微信账号隔离", () => {
  it("normalizeAccount 空值回落 default", () => {
    expect(normalizeAccount(undefined)).toBe("default");
    expect(normalizeAccount(null)).toBe("default");
    expect(normalizeAccount("")).toBe("default");
    expect(normalizeAccount("   ")).toBe("default");
    expect(normalizeAccount("wx_account_a")).toBe("wx_account_a");
    expect(normalizeAccount("  wx_b  ")).toBe("wx_b");
  });

  it("contactIdForChannel 相同 wxid 不同账号派生不同 contactId", () => {
    const wxid = "wxid_sb9or2x9zxj012";
    const a = contactIdForChannel("channel", wxid, "account-a");
    const b = contactIdForChannel("channel", wxid, "account-b");
    const def = contactIdForChannel("channel", wxid);
    expect(a).not.toBe(b);
    expect(def).not.toBe(a);
    // default 账号保持旧格式 ID（兼容存量数据，ADR-0005 不回写历史）
    expect(def).toBe(`contact:channel:${wxid}`);
    expect(a).toBe(`contact:channel:account-a:${wxid}`);
  });

  it("account 字段通过 ChannelEvent 契约传递（类型与默认值）", () => {
    const withAccount: ChannelEvent = {
      eventId: "e1",
      cursor: "1",
      conversationRef: "wxid_x",
      account: "acc-1",
      kind: "text",
      content: "hi",
      observedAt: "2026-08-24T00:00:00Z",
      isSelf: false,
    };
    expect(withAccount.account).toBe("acc-1");
    // 旧 Host 不带 account 时，契约允许缺省（兼容）
    const legacy: ChannelEvent = {
      eventId: "e2",
      cursor: "2",
      conversationRef: "wxid_y",
      kind: "text",
      content: "old",
      observedAt: "2026-08-24T00:00:00Z",
      isSelf: false,
    };
    expect(legacy.account ?? "default").toBe("default");
  });
});

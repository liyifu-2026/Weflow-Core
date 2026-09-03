/**
 * 群聊显示名兜底单测。
 */
import { describe, expect, it } from "vitest";
import {
  groupDisplayName,
  isChatroomContact,
} from "../modules/contacts/application/group-display-name.js";

describe("isChatroomContact", () => {
  it("识别群聊 ID（含账号隔离格式）", () => {
    expect(isChatroomContact("contact:channel:45868444838@chatroom")).toBe(true);
    expect(
      isChatroomContact(
        "contact:channel:wxid_gd6fxg4wqakd22_404c:45740750295@chatroom",
      ),
    ).toBe(true);
  });

  it("私聊 / 空值不是群聊", () => {
    expect(isChatroomContact("contact:channel:wxid_xxx")).toBe(false);
    expect(isChatroomContact(null)).toBe(false);
    expect(isChatroomContact(undefined)).toBe(false);
  });
});

describe("groupDisplayName", () => {
  it("已有可读群名原样返回", () => {
    expect(groupDisplayName("可可猫", "contact:channel:45740750295@chatroom")).toBe(
      "可可猫",
    );
  });

  it("裸 @chatroom ID → 「群聊 xxxxx」（取群号后 5 位）", () => {
    expect(
      groupDisplayName("45868444838@chatroom", "contact:channel:45868444838@chatroom"),
    ).toBe("群聊 44838");
  });

  it("账号隔离格式的 contactId 也能提取群号", () => {
    expect(
      groupDisplayName(
        "45868444838@chatroom",
        "contact:channel:wxid_gd6fxg4wqakd22_404c:45868444838@chatroom",
      ),
    ).toBe("群聊 44838");
  });

  it("displayName 为空时用 contactId 兜底", () => {
    expect(groupDisplayName(null, "contact:channel:45868444838@chatroom")).toBe(
      "群聊 44838",
    );
  });

  it("私聊不受影响", () => {
    expect(groupDisplayName("李工", "contact:channel:wxid_xxx")).toBe("李工");
  });
});

/**
 * 群聊显示名兜底单测。
 * ADR-0010：isGroup 由调用方以落库 chatType 事实传入，不再从 ID 猜测。
 */
import { describe, expect, it } from "vitest";
import { groupDisplayName } from "../modules/contacts/application/group-display-name.js";

describe("groupDisplayName", () => {
  it("已有可读群名原样返回", () => {
    expect(
      groupDisplayName("可可猫", "contact:channel:45740750295@chatroom", true),
    ).toBe("可可猫");
  });

  it("裸通道群 ID → 「群聊 xxxxx」（取群号后 5 位）", () => {
    expect(
      groupDisplayName(
        "45868444838@chatroom",
        "contact:channel:45868444838@chatroom",
        true,
      ),
    ).toBe("群聊 44838");
  });

  it("账号隔离格式的 contactId 也能提取群号", () => {
    expect(
      groupDisplayName(
        "45868444838@chatroom",
        "contact:channel:wxid_gd6fxg4wqakd22_404c:45868444838@chatroom",
        true,
      ),
    ).toBe("群聊 44838");
  });

  it("displayName 为空时用 contactId 兜底", () => {
    expect(
      groupDisplayName(null, "contact:channel:45868444838@chatroom", true),
    ).toBe("群聊 44838");
  });

  it("私聊（isGroup=false）不受影响，原样返回", () => {
    expect(groupDisplayName("李工", "contact:channel:wxid_xxx", false)).toBe(
      "李工",
    );
    expect(groupDisplayName("45868444838@chatroom", "contact:channel:45868444838@chatroom", false)).toBe(
      "45868444838@chatroom",
    );
  });
});

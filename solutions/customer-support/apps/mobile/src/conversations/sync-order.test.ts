import { describe, expect, it } from "vitest";
import type { ConversationPreview } from "./model";
import {
  conversationsDiffer,
  mergePreservingConversationOrder,
} from "./sync-order";

const item = (id: string, preview = id): ConversationPreview => ({
  id,
  name: id,
  company: "公司",
  preview,
  time: "刚刚",
  state: "mine",
});

describe("conversation background sync ordering", () => {
  it("keeps the current order while updating row content", () => {
    const current = [item("a"), item("b")];
    const incoming = [item("b", "更新"), item("a"), item("c")];

    expect(mergePreservingConversationOrder(current, incoming).map((row) => row.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(mergePreservingConversationOrder(current, incoming)[1].preview).toBe("更新");
  });

  it("ignores relative time changes when deciding whether to show new content", () => {
    expect(conversationsDiffer([item("a")], [{ ...item("a"), time: "1 分钟前" }])).toBe(false);
  });

  it("detects message and assignment changes", () => {
    expect(conversationsDiffer([item("a")], [item("a", "新消息")])).toBe(true);
    expect(
      conversationsDiffer([item("a")], [{ ...item("a"), owner: "李客服" }]),
    ).toBe(true);
  });
});

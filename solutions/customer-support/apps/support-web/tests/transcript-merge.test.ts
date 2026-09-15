import { describe, expect, it } from "vitest";
import {
  mergeTranscriptMessages,
  messagesDiffer,
} from "../src/components/conversations/transcript-merge";
import type { Message } from "../src/components/conversations/types";

function msg(overrides: Partial<Message> & { messageId: string }): Message {
  return { occurredAt: "2026-09-09T10:00:00Z", direction: "inbound", ...overrides };
}

describe("mergeTranscriptMessages", () => {
  it("新行进入 appended，保持服务端顺序", () => {
    const current = [msg({ messageId: "m2" })];
    const result = mergeTranscriptMessages(current, [
      msg({ messageId: "m1" }),
      msg({ messageId: "m2" }),
      msg({ messageId: "m3" }),
    ]);
    expect(result.appended.map((m) => m.messageId)).toEqual(["m1", "m3"]);
    expect(result.patchedCount).toBe(0);
    expect(result.messages).toBe(current);
  });

  it("已有行按差异就地打补丁（sendState 迁移）", () => {
    const known = msg({ messageId: "m1", sendState: "pending" });
    const result = mergeTranscriptMessages([known], [
      msg({ messageId: "m1", sendState: "confirmed" }),
    ]);
    expect(result.patchedCount).toBe(1);
    expect(result.messages[0].sendState).toBe("confirmed");
    expect(result.messages[0]).not.toBe(known);
    expect(result.appended).toHaveLength(0);
  });

  it("未变更行保持原对象引用（避免整列表重渲染）", () => {
    const known = msg({ messageId: "m1", text: "hi" });
    const incomingSame = msg({ messageId: "m1", text: "hi" });
    const result = mergeTranscriptMessages([known], [incomingSame]);
    expect(result.patchedCount).toBe(0);
    expect(result.messages[0]).toBe(known);
  });

  it("补丁保留本地特有字段（{...known, ...incoming} 语义）", () => {
    const known = msg({ messageId: "m1", sendState: "failed", mediaKind: "file" });
    const result = mergeTranscriptMessages([known], [
      msg({ messageId: "m1", sendState: "confirmed" }),
    ]);
    expect(result.messages[0].mediaKind).toBe("file");
    expect(result.messages[0].sendState).toBe("confirmed");
  });
});

describe("messagesDiffer", () => {
  it("对象/数组字段按 JSON 比较，而不是引用", () => {
    const known = msg({ messageId: "m1", mentionContactRefs: ["a"] });
    const same = msg({ messageId: "m1", mentionContactRefs: ["a"] });
    const diff = msg({ messageId: "m1", mentionContactRefs: ["b"] });
    expect(messagesDiffer(known, same)).toBe(false);
    expect(messagesDiffer(known, diff)).toBe(true);
  });
});

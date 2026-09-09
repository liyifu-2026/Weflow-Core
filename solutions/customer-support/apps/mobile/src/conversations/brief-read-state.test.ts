/**
 * 交接摘要已读状态测试
 * 验证按 account+conversation+cycle 隔离的已读记录与容量上限。
 */
import { describe, expect, it, vi } from "vitest";
import {
  markBriefRead,
  wasBriefRead,
} from "./brief-read-state";

const { memory } = vi.hoisted(() => {
  const memory = new Map<string, string>();
  return { memory };
});

vi.mock("@/storage/sensitive-storage", () => ({
  sensitiveStorage: {
    getItemAsync: (key: string) => Promise.resolve(memory.get(key) ?? null),
    setItemAsync: (key: string, value: string) => {
      memory.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key: string) => {
      memory.delete(key);
      return Promise.resolve();
    },
  },
}));

describe("brief read state", () => {
  it("is unread before marking", async () => {
    memory.clear();
    expect(
      await wasBriefRead("u-1", "conv-1", "cycle-1"),
    ).toBe(false);
  });

  it("marks a cycle as read", async () => {
    memory.clear();
    await markBriefRead("u-1", "conv-1", "cycle-1");
    expect(await wasBriefRead("u-1", "conv-1", "cycle-1")).toBe(true);
  });

  it("isolates by account, conversation and cycle", async () => {
    memory.clear();
    await markBriefRead("u-1", "conv-1", "cycle-1");
    expect(await wasBriefRead("u-2", "conv-1", "cycle-1")).toBe(false);
    expect(await wasBriefRead("u-1", "conv-2", "cycle-1")).toBe(false);
    expect(await wasBriefRead("u-1", "conv-1", "cycle-2")).toBe(false);
  });

  it("treats a new cycle as unread even for the same conversation", async () => {
    memory.clear();
    await markBriefRead("u-1", "conv-1", "cycle-1");
    await markBriefRead("u-1", "conv-1", "cycle-2");
    expect(await wasBriefRead("u-1", "conv-1", "cycle-1")).toBe(true);
    expect(await wasBriefRead("u-1", "conv-1", "cycle-2")).toBe(true);
  });

  it("caps stored records and keeps the newest", async () => {
    memory.clear();
    for (let index = 0; index < 210; index += 1) {
      await markBriefRead("u-1", `conv-${index}`, "cycle-1");
    }
    expect(await wasBriefRead("u-1", "conv-0", "cycle-1")).toBe(false);
    expect(await wasBriefRead("u-1", "conv-209", "cycle-1")).toBe(true);
  });

  it("recovers from corrupted stored data", async () => {
    memory.clear();
    memory.set("weflow.mobile.brief-read-state", "{broken");
    expect(await wasBriefRead("u-1", "conv-1", "cycle-1")).toBe(false);
    await markBriefRead("u-1", "conv-1", "cycle-1");
    expect(await wasBriefRead("u-1", "conv-1", "cycle-1")).toBe(true);
  });
});

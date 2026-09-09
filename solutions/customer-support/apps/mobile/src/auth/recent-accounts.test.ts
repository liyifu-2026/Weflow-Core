/**
 * 最近登录账号测试
 * 验证用户名列表的去重、上限与最近优先顺序；不涉及任何 token 或会话数据。
 */
import { describe, expect, it, vi } from "vitest";
import { loadRecentAccounts, recordRecentAccount } from "./recent-accounts";

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

describe("recent accounts", () => {
  it("returns an empty list before anything is recorded", async () => {
    memory.clear();
    expect(await loadRecentAccounts()).toEqual([]);
  });

  it("records usernames most-recent first", async () => {
    memory.clear();
    await recordRecentAccount("leaif");
    await recordRecentAccount("accept-b");
    expect(await loadRecentAccounts()).toEqual(["accept-b", "leaif"]);
  });

  it("deduplicates and moves a repeated account to the front", async () => {
    memory.clear();
    await recordRecentAccount("leaif");
    await recordRecentAccount("accept-b");
    await recordRecentAccount("leaif");
    expect(await loadRecentAccounts()).toEqual(["leaif", "accept-b"]);
  });

  it("keeps at most 5 accounts", async () => {
    memory.clear();
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      await recordRecentAccount(name);
    }
    const accounts = await loadRecentAccounts();
    expect(accounts).toHaveLength(5);
    expect(accounts[0]).toBe("f");
    expect(accounts[4]).toBe("b");
  });

  it("ignores empty usernames", async () => {
    memory.clear();
    await recordRecentAccount("   ");
    expect(await loadRecentAccounts()).toEqual([]);
  });

  it("recovers from corrupted stored data", async () => {
    memory.clear();
    memory.set("weflow.mobile.recent-accounts", "{not-json");
    expect(await loadRecentAccounts()).toEqual([]);
  });
});

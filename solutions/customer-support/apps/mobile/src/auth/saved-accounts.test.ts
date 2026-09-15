/**
 * 已保存账号测试
 * 验证卡片的最近优先排序、记住密码的保留/清除语义、上限与损坏数据兜底。
 */
import { describe, expect, it, vi } from "vitest";
import {
  loadSavedAccounts,
  rememberAccount,
  removeSavedAccount,
  seedFromRecentAccounts,
  touchAccount,
} from "./saved-accounts";

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

describe("saved accounts", () => {
  it("returns an empty list before anything is saved", async () => {
    memory.clear();
    expect(await loadSavedAccounts()).toEqual([]);
  });

  it("saves password when remembered and clears it when not", async () => {
    memory.clear();
    await rememberAccount({ username: "leaif", password: "secret-1" });
    expect((await loadSavedAccounts())[0]?.password).toBe("secret-1");
    // 取消「下次自动登录」再登录：记住账号但清除旧密码
    await rememberAccount({ username: "leaif" });
    const accounts = await loadSavedAccounts();
    expect(accounts[0]?.username).toBe("leaif");
    expect(accounts[0]?.password).toBeUndefined();
  });

  it("keeps remembered password when only touching display info", async () => {
    memory.clear();
    await rememberAccount({
      username: "leaif",
      password: "secret-1",
      avatarUrl: null,
      displayName: "旧名片",
    });
    await touchAccount("leaif", { displayName: "新名片" });
    const accounts = await loadSavedAccounts();
    expect(accounts[0]?.password).toBe("secret-1");
    expect(accounts[0]?.displayName).toBe("新名片");
    expect(accounts[0]?.avatarUrl).toBeNull();
  });

  it("moves a repeated login to the front and dedupes", async () => {
    memory.clear();
    await rememberAccount({ username: "leaif" });
    await rememberAccount({ username: "accept-b" });
    await rememberAccount({ username: "leaif" });
    const usernames = (await loadSavedAccounts()).map((a) => a.username);
    expect(usernames).toEqual(["leaif", "accept-b"]);
  });

  it("keeps at most 5 accounts", async () => {
    memory.clear();
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      await rememberAccount({ username: name });
    }
    const usernames = (await loadSavedAccounts()).map((a) => a.username);
    expect(usernames).toEqual(["f", "e", "d", "c", "b"]);
  });

  it("removes a saved account", async () => {
    memory.clear();
    await rememberAccount({ username: "leaif" });
    await rememberAccount({ username: "accept-b" });
    await removeSavedAccount("leaif");
    const usernames = (await loadSavedAccounts()).map((a) => a.username);
    expect(usernames).toEqual(["accept-b"]);
  });

  it("ignores empty usernames", async () => {
    memory.clear();
    await rememberAccount({ username: "   " });
    expect(await loadSavedAccounts()).toEqual([]);
  });

  it("recovers from corrupted stored data", async () => {
    memory.clear();
    memory.set("weflow.mobile.saved-accounts", "{not-json");
    expect(await loadSavedAccounts()).toEqual([]);
  });

  it("seeds cards from legacy recent usernames when empty", async () => {
    memory.clear();
    await seedFromRecentAccounts(async () => ["leaif", "accept-b"]);
    const accounts = await loadSavedAccounts();
    expect(accounts.map((a) => a.username)).toEqual(["leaif", "accept-b"]);
    expect(accounts[0]?.password).toBeUndefined();
  });

  it("skips seeding when cards already exist", async () => {
    memory.clear();
    await rememberAccount({ username: "new-user", password: "secret-1" });
    await seedFromRecentAccounts(async () => ["leaif"]);
    const accounts = await loadSavedAccounts();
    expect(accounts.map((a) => a.username)).toEqual(["new-user"]);
  });

  it("seeding tolerates a failing legacy source", async () => {
    memory.clear();
    await seedFromRecentAccounts(async () => {
      throw new Error("storage unavailable");
    });
    expect(await loadSavedAccounts()).toEqual([]);
  });
});

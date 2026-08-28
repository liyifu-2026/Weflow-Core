/**
 * 敏感数据存储测试
 * 验证 Web 平台使用内存存储，以及原生平台 SecureStore 不可用时的错误处理。
 */
import { describe, expect, it, vi } from "vitest";
import { createSensitiveStorage } from "./sensitive-storage-core";

function secureStoreUnavailable() {
  return {
    isAvailableAsync: vi.fn().mockResolvedValue(false),
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
  };
}

describe("sensitive storage", () => {
  it("keeps web values in memory without calling native SecureStore", async () => {
    const secureStore = secureStoreUnavailable();
    const storage = createSensitiveStorage("web", secureStore);

    await storage.setItemAsync("session", "secret");
    await expect(storage.getItemAsync("session")).resolves.toBe("secret");
    await storage.deleteItemAsync("session");
    await expect(storage.getItemAsync("session")).resolves.toBeNull();

    expect(secureStore.isAvailableAsync).not.toHaveBeenCalled();
    expect(secureStore.getItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("fails closed when native SecureStore is unavailable", async () => {
    const storage = createSensitiveStorage("android", secureStoreUnavailable());

    await expect(storage.getItemAsync("session")).rejects.toThrow(
      "SecureStore is unavailable",
    );
  });
});

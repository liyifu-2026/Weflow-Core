import { describe, expect, it } from "vitest";
import {
  migrateMobileStorageKeys,
  type MobileStorage,
} from "./mobile-key-migration";

function createMemoryStorage(initial?: Record<string, string>): MobileStorage & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    values,
    getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => {
      values.set(key, value);
    },
    deleteItemAsync: async (key) => {
      values.delete(key);
    },
  };
}

describe("mobile storage key migration", () => {
  it("copies, verifies, and removes exact legacy keys", async () => {
    const storage = createMemoryStorage({
      "weflow.client1.mobile-session": '{"sessionToken":"token"}',
      "client1.theme.mode": "dark",
    });

    await migrateMobileStorageKeys({
      storage,
      digest: async () => "digest",
    });

    expect(storage.values.get("weflow.mobile.session")).toBe(
      '{"sessionToken":"token"}',
    );
    expect(storage.values.get("mobile.theme.mode")).toBe("dark");
    expect(storage.values.has("weflow.client1.mobile-session")).toBe(false);
    expect(storage.values.has("client1.theme.mode")).toBe(false);
  });

  it("migrates account-scoped values and indexed cache entries", async () => {
    const storage = createMemoryStorage({
      "weflow.client1.notification-preference.digest": "{\"showPreview\":true}",
      "weflow.client1.krecents.digest": "[]",
      "weflow.client1.draft-index.digest":
        '["weflow.client1.draft.digest-conversation"]',
      "weflow.client1.draft.digest-conversation": "draft",
      "weflow.client1.transcript-cache-index.digest":
        '["weflow.client1.transcript-cache.digest-conversation"]',
      "weflow.client1.transcript-cache.digest-conversation": "transcript",
    });

    await migrateMobileStorageKeys(
      { storage, digest: async () => "digest" },
      "account-id",
    );

    expect(storage.values.get("weflow.mobile.notification-preference.digest")).toBe(
      '{"showPreview":true}',
    );
    expect(storage.values.get("weflow.mobile.draft.digest-conversation")).toBe(
      "draft",
    );
    expect(storage.values.get("weflow.mobile.transcript-cache.digest-conversation")).toBe(
      "transcript",
    );
    expect(storage.values.has("weflow.client1.draft-index.digest")).toBe(false);
    expect(storage.values.has("weflow.client1.draft.digest-conversation")).toBe(
      false,
    );
    expect(storage.values.get("weflow.mobile.draft-index.digest")).toBe(
      '["weflow.mobile.draft.digest-conversation"]',
    );
  });

  it("keeps the legacy value when the new key contains a different value", async () => {
    const storage = createMemoryStorage({
      "weflow.client1.mobile-session": "legacy",
      "weflow.mobile.session": "new",
    });

    await migrateMobileStorageKeys({ storage, digest: async () => "digest" });

    expect(storage.values.get("weflow.client1.mobile-session")).toBe("legacy");
    expect(storage.values.get("weflow.mobile.session")).toBe("new");
  });
});

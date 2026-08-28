import { describe, expect, it } from "vitest";
import { createDraftStore } from "./draft-store-core";
import type { LocalDraft } from "./draft-store-core";

/** 内存存储：不引入真实 SecureStore。 */
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItemAsync: (key: string) => Promise.resolve(values.get(key) ?? null),
    setItemAsync: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key: string) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

/** 确定性摘要：键名不泄露业务标识，且同一输入恒等同一键。 */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

const digest = (value: string) => Promise.resolve(fnv1a(value));

const draft = (overrides: Partial<LocalDraft> = {}): LocalDraft => ({
  accountId: "agent-1",
  conversationId: "conversation-1",
  handoffId: "cycle-1",
  baseConversationRevision: 4,
  reviewedAtRevision: 4,
  content: "建议先恢复文件。",
  source: "suggested",
  status: "saved_local",
  updatedAt: "2026-08-04T00:00:00.000Z",
  ...overrides,
});

describe("draft store roundtrip", () => {
  it("restores the draft after save and reload", async () => {
    const store = createDraftStore({ storage: memoryStorage(), digest: digest });
    await store.saveDraft(draft());
    const loaded = await store.loadDraft("agent-1", "conversation-1", "cycle-1");
    expect(loaded).toMatchObject({
      content: "建议先恢复文件。",
      source: "suggested",
      status: "saved_local",
      baseConversationRevision: 4,
    });
  });

  it("keeps the draft until it is explicitly deleted", async () => {
    const store = createDraftStore({ storage: memoryStorage(), digest: digest });
    await store.saveDraft(draft());
    await store.deleteDraft("agent-1", "conversation-1", "cycle-1");
    await expect(
      store.loadDraft("agent-1", "conversation-1", "cycle-1"),
    ).resolves.toBeUndefined();
  });

  it("persists an unknown message request until its outcome is checked", async () => {
    const store = createDraftStore({ storage: memoryStorage(), digest });
    await store.saveDraft(
      draft({
        content: "",
        source: "manual",
        pendingMessage: {
          clientRequestId: "request-1",
          text: "请确认指示灯状态。",
          occurredAt: "2026-08-11T02:00:00.000Z",
          expectedConversationRevision: 4,
        },
      }),
    );
    await expect(
      store.loadDraft("agent-1", "conversation-1", "cycle-1"),
    ).resolves.toMatchObject({
      pendingMessage: {
        clientRequestId: "request-1",
        expectedConversationRevision: 4,
      },
    });
  });

  it("finds the latest draft for a conversation after its cycle changes", async () => {
    const store = createDraftStore({ storage: memoryStorage(), digest });
    await store.saveDraft(
      draft({
        handoffId: "cycle-old",
        status: "archived_transfer",
        updatedAt: "2026-08-11T02:00:00.000Z",
      }),
    );
    await expect(
      store.loadLatestConversationDraft("agent-1", "conversation-1"),
    ).resolves.toMatchObject({
      handoffId: "cycle-old",
      content: "建议先恢复文件。",
    });
  });
});

describe("draft account isolation", () => {
  it("never exposes another account's draft", async () => {
    const store = createDraftStore({ storage: memoryStorage(), digest: digest });
    await store.saveDraft(draft({ accountId: "agent-a" }));
    await expect(
      store.loadDraft("agent-b", "conversation-1", "cycle-1"),
    ).resolves.toBeUndefined();
    await expect(
      store.loadDraft("agent-a", "conversation-1", "cycle-1"),
    ).resolves.toMatchObject({ accountId: "agent-a" });
  });

  it("clears only the target account's drafts", async () => {
    const store = createDraftStore({ storage: memoryStorage(), digest: digest });
    await store.saveDraft(draft({ accountId: "agent-a" }));
    await store.saveDraft(draft({ accountId: "agent-b", content: "另一账号草稿" }));
    await store.clearAccountDrafts("agent-a");
    await expect(
      store.loadDraft("agent-a", "conversation-1", "cycle-1"),
    ).resolves.toBeUndefined();
    await expect(
      store.loadDraft("agent-b", "conversation-1", "cycle-1"),
    ).resolves.toMatchObject({ content: "另一账号草稿" });
  });

  it("isolates drafts by conversation within the same account", async () => {
    const store = createDraftStore({ storage: memoryStorage(), digest: digest });
    await store.saveDraft(draft({ conversationId: "conversation-1" }));
    await expect(
      store.loadDraft("agent-1", "conversation-2", "cycle-1"),
    ).resolves.toBeUndefined();
  });
});

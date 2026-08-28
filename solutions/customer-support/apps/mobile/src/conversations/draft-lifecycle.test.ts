import { describe, expect, it } from "vitest";
import {
  canSendDraft,
  isDraftOwner,
  restoredDraftStatus,
  restoredDraftForCycle,
  restoreDraftAfterSendFailure,
} from "./draft-lifecycle";
import type { LocalDraft } from "./draft-store";

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

describe("restoredDraftStatus", () => {
  it("keeps the draft content and saved status after leave and return", () => {
    const saved = draft();
    expect(restoredDraftStatus(saved, 4)).toBe("saved_local");
  });

  it("archives a draft when ownership moved to a new cycle", () => {
    expect(restoredDraftForCycle(draft(), "cycle-2", 4)).toBe(
      "archived_transfer",
    );
  });

  it("marks the draft stale when the revision advanced and the new content is unreviewed", () => {
    const saved = draft({ baseConversationRevision: 4, reviewedAtRevision: 4 });
    expect(restoredDraftStatus(saved, 5)).toBe("stale_revision");
  });

  it("keeps stale status until the latest revision is reviewed", () => {
    const saved = draft({ status: "stale_revision" });
    expect(restoredDraftStatus(saved, 5)).toBe("stale_revision");
  });
});

describe("canSendDraft", () => {
  it("blocks an unreviewed stale draft", () => {
    expect(canSendDraft("stale_revision", 4, 5)).toBe(false);
  });

  it("allows a stale draft after the latest revision is reviewed", () => {
    expect(canSendDraft("stale_revision", 5, 5)).toBe(true);
  });

  it("blocks locked drafts", () => {
    expect(canSendDraft("locked_reauth", 5, 5)).toBe(false);
  });

  it("never sends a draft archived from another cycle", () => {
    expect(canSendDraft("archived_transfer", 5, 5)).toBe(false);
  });

  it("allows a fresh saved draft", () => {
    expect(canSendDraft("saved_local", 5, 5)).toBe(true);
  });
});

describe("restoreDraftAfterSendFailure", () => {
  const input = {
    accountId: "agent-1",
    conversationId: "conversation-1",
    handoffId: "cycle-1",
    content: "建议先恢复文件。",
    source: "suggested" as const,
    evidenceId: "chunk-1",
    reviewedAtRevision: 4,
    failure: "retryable_failed",
  };

  it("keeps the draft text after a retryable failure", () => {
    expect(restoreDraftAfterSendFailure(input)).toMatchObject({
      content: "建议先恢复文件。",
      status: "saved_local",
      baseConversationRevision: null,
      reviewedAtRevision: 4,
      evidenceId: "chunk-1",
    });
  });

  it("drops the draft when permission is lost", () => {
    expect(
      restoreDraftAfterSendFailure({ ...input, failure: "permission_lost" }),
    ).toBeUndefined();
  });
});

describe("isDraftOwner", () => {
  it("lets the assigned agent send after claiming", () => {
    expect(isDraftOwner("HUMAN_ACTIVE", "agent-1", "agent-1")).toBe(true);
  });

  it("locks the draft after the conversation is transferred away", () => {
    expect(isDraftOwner("HUMAN_ACTIVE", "agent-2", "agent-1")).toBe(false);
  });

  it("locks the draft when the handoff is no longer in progress", () => {
    expect(isDraftOwner("HUMAN_FINISHED", "agent-1", "agent-1")).toBe(false);
    expect(isDraftOwner(undefined, undefined, "agent-1")).toBe(false);
  });
});

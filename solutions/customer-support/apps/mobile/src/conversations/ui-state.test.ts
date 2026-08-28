import { describe, expect, it } from "vitest";
import type { HandoffDetail } from "./api";
import { deriveConversationUiState } from "./ui-state";

const base: HandoffDetail = {
  state: {
    conversationId: "conversation-1",
    cycleId: "cycle-1",
    handoffRevision: 3,
    assignedQueueId: null,
    status: "HANDOFF_PENDING",
    assignedUserId: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    acceptedAt: null,
    resolvedAt: null,
  },
  cycles: [],
  briefing: null,
  activeTransferNote: null,
};

describe("conversation UI state", () => {
  it("requires a claim for an unassigned pending handoff", () => {
    expect(deriveConversationUiState(base, "agent-1", false)).toMatchObject({
      mode: "claim",
      primaryAction: "claim",
      showComposer: false,
    });
  });

  it("allows an eligible queue member to claim a pending handoff", () => {
    expect(
      deriveConversationUiState(
        {
          ...base,
          state: {
            ...base.state,
            assignedQueueId: "queue-1",
            canClaim: true,
          },
        },
        "agent-1",
        false,
      ),
    ).toMatchObject({ mode: "claim", showComposer: false });
  });

  it("keeps an ineligible pending handoff read-only", () => {
    expect(
      deriveConversationUiState(
        { ...base, state: { ...base.state, canClaim: false } },
        "agent-1",
        false,
      ),
    ).toMatchObject({ mode: "waiting", showComposer: false });
  });

  it("shows the reply workflow only to the assigned agent", () => {
    const handoff = {
      ...base,
      state: {
        ...base.state,
        status: "HUMAN_ACTIVE" as const,
        assignedUserId: "agent-1",
        acceptedAt: "2026-08-04T00:01:00.000Z",
      },
    };
    expect(deriveConversationUiState(handoff, "agent-1", false)).toMatchObject({
      mode: "reply",
      primaryAction: "reply",
      showComposer: true,
    });
    expect(deriveConversationUiState(handoff, "agent-2", false)).toMatchObject({
      mode: "readonly",
      showComposer: false,
    });
  });

  it("keeps the owner's composer for offline draft editing", () => {
    const handoff = {
      ...base,
      state: {
        ...base.state,
        status: "HUMAN_ACTIVE" as const,
        assignedUserId: "agent-1",
      },
    };
    expect(deriveConversationUiState(handoff, "agent-1", true)).toMatchObject({
      mode: "offline_draft",
      availableActions: ["view"],
      showComposer: true,
    });
  });

  it("does not turn an absent handoff into an implicit claim action", () => {
    expect(deriveConversationUiState(undefined, "agent-1", false)).toMatchObject({
      mode: "readonly",
      showComposer: false,
    });
  });

  it("offers accept and reject only to the transfer target", () => {
    const handoff = {
      ...base,
      state: {
        ...base.state,
        status: "TRANSFER_PENDING" as const,
        targetUserId: "agent-1",
        canClaim: true,
      },
    };
    expect(deriveConversationUiState(handoff, "agent-1", false)).toMatchObject({
      mode: "transfer_offer",
      availableActions: ["claim", "reject_transfer", "view"],
    });
    expect(deriveConversationUiState(handoff, "agent-2", false)).toMatchObject({
      mode: "waiting",
      showComposer: false,
    });
  });

  it("hides reject when Core does not authorize it", () => {
    const state = deriveConversationUiState(
      {
        ...base,
        state: {
          ...base.state,
          status: "TRANSFER_PENDING" as const,
          targetUserId: "agent-1",
          canClaim: true,
          canRejectTransfer: false,
        },
      },
      "agent-1",
      false,
    );
    expect(state.availableActions).not.toContain("reject_transfer");
  });

  it("keeps resolved handoffs read-only until Core exposes reopen", () => {
    expect(
      deriveConversationUiState(
        { ...base, state: { ...base.state, status: "HUMAN_FINISHED" } },
        "agent-1",
        false,
      ),
    ).toMatchObject({ mode: "readonly", showComposer: false });
  });
});

describe("manual takeover（AGENT_ACTIVE）", () => {
  it("无 handoff 且可接管时提供 takeover 模式", () => {
    expect(deriveConversationUiState(undefined, "agent-1", false, true)).toMatchObject({
      mode: "takeover",
      primaryAction: "claim",
      showComposer: false,
    });
  });

  it("无 handoff 但不可接管（capability 关闭）时保持只读", () => {
    expect(deriveConversationUiState(undefined, "agent-1", false, false)).toMatchObject({
      mode: "readonly",
      showComposer: false,
    });
  });

  it("离线时不可接管（不发起服务端写操作）", () => {
    expect(deriveConversationUiState(undefined, "agent-1", true, true)).toMatchObject({
      mode: "readonly",
      showComposer: false,
    });
  });

  it("有 handoff 时即使传入 canTakeover 也走既有流程", () => {
    expect(
      deriveConversationUiState(base, "agent-1", false, true),
    ).toMatchObject({ mode: "claim" });
  });
});

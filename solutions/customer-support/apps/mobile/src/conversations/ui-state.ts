import type { HandoffDetail } from "./api";

export type ConversationUiMode =
  | "claim"
  | "transfer_offer"
  | "reply"
  | "offline_draft"
  | "takeover"
  | "waiting"
  | "readonly";

export type ConversationUiAction =
  | "claim"
  | "reject_transfer"
  | "reply"
  | "assist"
  | "transfer"
  | "resolve"
  | "view";

export type ConversationUiState = {
  mode: ConversationUiMode;
  primaryAction?: "claim" | "reply";
  availableActions: ConversationUiAction[];
  showBriefing: boolean;
  showComposer: boolean;
};

/** Derive the single customer-service action from server-owned handoff state. */
export function deriveConversationUiState(
  handoff: HandoffDetail | undefined,
  currentUserId: string | undefined,
  offline: boolean,
  canTakeover = false,
): ConversationUiState {
  const showBriefing = Boolean(handoff?.briefing);
  const isOwner =
    handoff?.state.status === "HUMAN_ACTIVE" &&
    handoff.state.assignedUserId === currentUserId;
  if (offline && isOwner) {
    return {
      mode: "offline_draft",
      availableActions: ["view"],
      showBriefing,
      showComposer: true,
    };
  }
  if (offline) {
    return {
      mode: "readonly",
      availableActions: ["view"],
      showBriefing,
      showComposer: false,
    };
  }
  if (!handoff) {
    // AGENT_ACTIVE：capability 开启且服务端允许时提供主动接管；否则只读
    if (canTakeover) {
      return {
        mode: "takeover",
        primaryAction: "claim",
        availableActions: ["claim", "view"],
        showBriefing,
        showComposer: false,
      };
    }
    return {
      mode: "readonly",
      availableActions: ["view"],
      showBriefing,
      showComposer: false,
    };
  }
  if (handoff.state.status === "TRANSFER_PENDING") {
    if (
      handoff.state.targetUserId === currentUserId &&
      handoff.state.canClaim !== false
    ) {
      return {
        mode: "transfer_offer",
        primaryAction: "claim",
        availableActions:
          handoff.state.canRejectTransfer === false
            ? ["claim", "view"]
            : ["claim", "reject_transfer", "view"],
        showBriefing,
        showComposer: false,
      };
    }
    return {
      mode: "waiting",
      availableActions: ["view"],
      showBriefing,
      showComposer: false,
    };
  }
  if (handoff.state.status === "HANDOFF_PENDING") {
    if (handoff.state.canClaim === false) {
      return {
        mode: "waiting",
        availableActions: ["view"],
        showBriefing,
        showComposer: false,
      };
    }
    return {
      mode: "claim",
      primaryAction: "claim",
      availableActions: ["claim", "view"],
      showBriefing,
      showComposer: false,
    };
  }
  if (handoff.state.status === "HUMAN_ACTIVE") {
    if (isOwner) {
      return {
        mode: "reply",
        primaryAction: "reply",
        availableActions: [
          "reply",
          "assist",
          "transfer",
          "resolve",
          "view",
        ],
        showBriefing,
        showComposer: true,
      };
    }
    return {
      mode: "readonly",
      availableActions: ["view"],
      showBriefing,
      showComposer: false,
    };
  }
  return {
    mode: "readonly",
    availableActions: ["view"],
    showBriefing,
    showComposer: false,
  };
}

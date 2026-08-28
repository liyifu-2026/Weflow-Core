import { ApiError, request } from "./client";
import type { MobileSession } from "@/auth/session";

export type MobileCapabilities = {
  mobileHandoffInbox: boolean;
  handoffRevision: boolean;
  structuredBrief: boolean;
  transferCycle: boolean;
  transferToUser: boolean;
  transferToQueue: boolean;
  transferFallback: boolean;
  humanFinish: boolean;
  handoffOutcomeQuery: boolean;
  requestOutcome: boolean;
  structuredSuggestion: boolean;
  suggestionV2: boolean;
  /** 人工主动接管 Agent 处理中会话（AGENT_ACTIVE → Manual Takeover） */
  mobileManualTakeover: boolean;
  /** 信息名片（显示名/专家标签/改密入口）；旧 Core 为 false */
  agentProfile: boolean;
};

export const legacyMobileCapabilities: MobileCapabilities = {
  mobileHandoffInbox: false,
  handoffRevision: false,
  structuredBrief: false,
  transferCycle: false,
  transferToUser: false,
  transferToQueue: false,
  transferFallback: false,
  humanFinish: false,
  handoffOutcomeQuery: false,
  requestOutcome: false,
  structuredSuggestion: false,
  suggestionV2: false,
  mobileManualTakeover: false,
  agentProfile: false,
};

/** Missing capability endpoint means a legacy Core; other failures stay visible. */
export async function getMobileCapabilities(
  session: MobileSession,
): Promise<MobileCapabilities> {
  try {
    const result = await request<{ capabilities: Partial<MobileCapabilities> }>(
      "/api/v1/mobile/capabilities",
      { token: session.sessionToken },
    );
    return { ...legacyMobileCapabilities, ...result.capabilities };
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) {
      return legacyMobileCapabilities;
    }
    throw reason;
  }
}

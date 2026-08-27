/**
 * Platform-neutral group chat response policy (ADR-0006).
 *
 * Solutions configure these rules; the platform decides whether a group
 * message should produce an Agent Turn.
 *
 * Group chat reply differentiation:
 * - Responses should be concise (2-3 sentences max)
 * - No private information or personalized content for specific contacts
 * - Only respond when @-mentioned or keyword-matched (configurable)
 * - The system prompt for group chats includes additional constraints
 *   (see agent-context.ts chatType hint and strategy prompt.ts)
 */

export type GroupChatPolicy = {
  readonly acceptAll: boolean;
  readonly replyWhenMentioned: boolean;
  readonly keywords: readonly string[];
  readonly responseProbability: number; // 0..1, only used when acceptAll is true
};

export type GroupMessageContext = {
  readonly text: string;
  readonly mentioned: boolean;
};

export const DEFAULT_GROUP_CHAT_POLICY: GroupChatPolicy = {
  acceptAll: false,
  replyWhenMentioned: true,
  keywords: [],
  responseProbability: 0,
};

export function shouldRespondToGroupMessage(
  policy: GroupChatPolicy,
  message: GroupMessageContext,
  random = Math.random,
): boolean {
  if (policy.replyWhenMentioned && message.mentioned) return true;
  const text = message.text.trim().toLowerCase();
  if (
    policy.keywords.some(
      (keyword) =>
        keyword.trim().toLowerCase() &&
        text.includes(keyword.trim().toLowerCase()),
    )
  ) {
    return true;
  }
  if (!policy.acceptAll) return false;
  const probability = Math.min(1, Math.max(0, policy.responseProbability));
  return probability >= 1 || random() < probability;
}

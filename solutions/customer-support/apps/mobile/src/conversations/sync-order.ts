import type { ConversationPreview } from "./model";

/**
 * Keep the visible order stable during background sync. A manual refresh
 * accepts Core's latest business order without calculating priority here.
 */
export function mergePreservingConversationOrder(
  current: ConversationPreview[],
  incoming: ConversationPreview[],
): ConversationPreview[] {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const currentIds = new Set(current.map((item) => item.id));
  const existing = current
    .map((item) => incomingById.get(item.id))
    .filter((item): item is ConversationPreview => Boolean(item));
  const added = incoming.filter((item) => !currentIds.has(item.id));
  return [...existing, ...added];
}

/** Detect changes that matter to a queue row, excluding relative timestamps. */
export function conversationsDiffer(
  current: ConversationPreview[],
  incoming: ConversationPreview[],
): boolean {
  if (current.length !== incoming.length) return true;
  const currentById = new Map(current.map((item) => [item.id, item]));
  return incoming.some((item) => {
    const previous = currentById.get(item.id);
    if (!previous) return true;
    return (
      previous.name !== item.name ||
      previous.company !== item.company ||
      previous.preview !== item.preview ||
      previous.state !== item.state ||
      previous.owner !== item.owner ||
      previous.assignedQueueId !== item.assignedQueueId ||
      previous.unread !== item.unread ||
      previous.attentionReason !== item.attentionReason ||
      previous.pendingSince !== item.pendingSince
    );
  });
}

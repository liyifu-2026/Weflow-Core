/**
 * Plugin event dispatcher.
 *
 * Forwards platform events to installed Solution plugins that declared
 * `eventSubscriptions`. Delivery is best-effort: failures are logged and
 * never break the platform event flow.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../../infrastructure/postgres/schema.js";
import { conversationEvents } from "../../../infrastructure/events/conversation-events.js";
import { listEventSubscriptions } from "./solution-installation-service.js";

type Database = NodePgDatabase<typeof schema>;

export async function dispatchPluginEvent(
  db: Database,
  eventName: string,
  payload: unknown,
): Promise<number> {
  const subscriptions = await listEventSubscriptions(db);
  let notified = 0;
  for (const subscription of subscriptions) {
    if (!subscription.events.includes(eventName)) continue;
    for (const route of subscription.routes) {
      const target = `${route.target.replace(/\/$/, "")}/events/${encodeURIComponent(eventName)}`;
      try {
        const response = await fetch(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: eventName,
            pluginId: subscription.pluginId,
            payload,
            deliveredAt: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) notified += 1;
      } catch (error) {
        console.error(
          { pluginId: subscription.pluginId, eventName, error },
          "plugin event delivery failed",
        );
      }
    }
  }
  return notified;
}

export function startPluginEventDispatcher(db: Database): () => void {
  return conversationEvents.on((event) => {
    void dispatchPluginEvent(db, event.type, event).catch((error: unknown) => {
      console.error(
        { error, eventType: event.type },
        "plugin event dispatch failed",
      );
    });
  });
}

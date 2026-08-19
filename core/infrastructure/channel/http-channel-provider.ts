/**
 * Generic HTTP Channel Provider.
 *
 * Speaks the Weflow Channel Host HTTP protocol: pulls channel events, contacts
 * and media from a remote Channel Host and submits outbound send operations.
 * The provider is channel-agnostic — a Channel Host may back any messaging
 * channel (chat, SMS, social messaging, ...) as long as it implements the
 * protocol.
 *
 * Protocol endpoints (all under the configured base URL):
 * - GET  /api/v1/channel/events?afterCursor=&limit=
 * - GET  /api/v1/channel/contacts?afterCursor=&limit=
 * - GET  /api/v1/channel/media/:mediaRef
 * - POST /api/v1/channel/send
 * - GET  /api/v1/channel/send-operations/:operationId
 */
import { z } from "zod";
import type {
  ChannelEvent,
  ChannelEventSource,
  ChannelEventsPage,
  PullChannelEventsInput,
} from "../../modules/channel/contracts/channel-event-source.js";
import type {
  ChannelMediaResult,
  ChannelMediaSource,
} from "../../modules/channel/contracts/channel-media-source.js";
import type {
  ChannelContact,
  ChannelContactSource,
  ChannelContactsPage,
} from "../../modules/channel/contracts/channel-contact-source.js";
import type {
  ChannelSendOperation,
  ChannelSendOperations,
  CreateChannelSendOperationInput,
} from "../../modules/channel/contracts/channel-send-operations.js";
import type { PluginDefinition } from "../runtime/kernel/index.js";
import { CHANNEL_EVENTS_CAPABILITY } from "../runtime/capabilities/channel-events.js";
import { CHANNEL_MEDIA_CAPABILITY } from "../runtime/capabilities/channel-media.js";
import { CHANNEL_SEND_CAPABILITY } from "../runtime/capabilities/channel-send.js";
import { CHANNEL_CONTACTS_CAPABILITY } from "../runtime/capabilities/channel-contacts.js";

const hostEventSchema = z
  .object({
    eventId: z.string().min(1),
    cursor: z.string().min(1),
    conversationRef: z.string().min(1),
    channelMessageId: z.string().nullable().optional(),
    senderRef: z.string().nullable().optional(),
    kind: z.string().min(1),
    content: z.string(),
    mediaRef: z.string().nullable().optional(),
    occurredAt: z.string().nullable().optional(),
    observedAt: z.string().min(1),
    isSelf: z.boolean(),
  })
  .strict();

const hostEventsResponseSchema = z
  .object({
    events: z.array(hostEventSchema),
    nextCursor: z.string().min(1),
    hasMore: z.boolean(),
  })
  .strict();

const hostContactSchema = z
  .object({
    contactRef: z.string().min(1),
    displayName: z.string().min(1),
    nickname: z.string().nullable(),
    remark: z.string().nullable(),
    alias: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    contactType: z.string().min(1),
  })
  .strict();

const hostContactsResponseSchema = z
  .object({
    contacts: z.array(hostContactSchema),
    nextCursor: z.string(),
    hasMore: z.boolean(),
  })
  .strict();

const hostSendOperationSchema = z
  .object({
    operationId: z.string().min(1),
    conversationRef: z.string().min(1),
    payload: z
      .object({
        kind: z.literal("text"),
        text: z.string(),
      })
      .strict(),
    state: z.enum(["pending", "confirmed", "unknown", "failed"]),
    error: z.string().nullable(),
    channelMessageId: z.string().nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export class ChannelProviderError extends Error {
  public constructor(
    public readonly code:
      | "channel_transport_unavailable"
      | "channel_http_error"
      | "channel_protocol_invalid",
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ChannelProviderError";
  }
}

export type HttpChannelProviderOptions = {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export class HttpChannelProvider
  implements
    ChannelEventSource,
    ChannelMediaSource,
    ChannelSendOperations,
    ChannelContactSource
{
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  public constructor(options: HttpChannelProviderOptions) {
    if (!options.token) throw new Error("channel_host_token_required");
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async pullEvents(
    input: PullChannelEventsInput,
  ): Promise<ChannelEventsPage> {
    const query = new URLSearchParams({
      afterCursor: input.afterCursor ?? "0",
      limit: String(input.limit ?? 100),
    });
    const url = `${this.#baseUrl}/api/v1/channel/events?${query.toString()}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${this.#token}` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ChannelProviderError(
        "channel_transport_unavailable",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new ChannelProviderError(
        "channel_http_error",
        `Host returned ${String(response.status)}`,
      );
    }
    try {
      const payload = hostEventsResponseSchema.parse(await response.json());
      return {
        events: payload.events.map(toChannelEvent),
        nextCursor: payload.nextCursor,
        hasMore: payload.hasMore,
      };
    } catch (error) {
      throw new ChannelProviderError(
        "channel_protocol_invalid",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  public async pullContacts(input: {
    afterCursor?: string;
    limit?: number;
  }): Promise<ChannelContactsPage> {
    const query = new URLSearchParams({
      afterCursor: input.afterCursor ?? "",
      limit: String(input.limit ?? 100),
    });
    const response = await this.#request(
      `${this.#baseUrl}/api/v1/channel/contacts?${query.toString()}`,
      { method: "GET" },
    );
    try {
      const payload = hostContactsResponseSchema.parse(response);
      return {
        contacts: payload.contacts.map(toChannelContact),
        nextCursor: payload.nextCursor,
        hasMore: payload.hasMore,
      };
    } catch (error) {
      throw new ChannelProviderError(
        "channel_protocol_invalid",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  public async create(
    input: CreateChannelSendOperationInput,
  ): Promise<ChannelSendOperation> {
    if (input.payload.kind !== "text") {
      throw new Error("channel_send_payload_unsupported:text_only");
    }
    const response = await this.#request(
      `${this.#baseUrl}/api/v1/channel/send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    return parseSendOperation(response);
  }

  public async resolveImage(mediaRef: string): Promise<ChannelMediaResult> {
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/api/v1/channel/media/${encodeURIComponent(mediaRef)}`,
        {
          headers: { authorization: `Bearer ${this.#token}` },
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch (error) {
      throw new ChannelProviderError(
        "channel_transport_unavailable",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    if (response.status === 202) return { state: "pending" };
    if (response.status === 404) return { state: "not_found" };
    if (response.status === 422) {
      try {
        const body = z
          .object({ error: z.string().min(1) })
          .parse(await response.json());
        return { state: "failed", errorCode: body.error };
      } catch {
        return { state: "failed", errorCode: "media_unreadable" };
      }
    }
    if (!response.ok || !response.body) {
      throw new ChannelProviderError(
        "channel_http_error",
        `Host returned ${String(response.status)}`,
      );
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0];
    if (
      mimeType !== "image/jpeg" &&
      mimeType !== "image/png" &&
      mimeType !== "image/gif"
    ) {
      await response.body.cancel();
      return { state: "failed", errorCode: "media_mime_unsupported" };
    }
    return { state: "ready", body: response.body, mimeType };
  }

  public async get(
    operationId: string,
  ): Promise<ChannelSendOperation | undefined> {
    const response = await this.#request(
      `${this.#baseUrl}/api/v1/channel/send-operations/${encodeURIComponent(operationId)}`,
      { method: "GET", allowNotFound: true },
    );
    return response === undefined ? undefined : parseSendOperation(response);
  }

  async #request(
    url: string,
    init: RequestInit & { allowNotFound?: boolean },
  ): Promise<unknown> {
    const { allowNotFound, ...requestInit } = init;
    let response: Response;
    try {
      const headers = requestHeaders(init.headers);
      headers.authorization = `Bearer ${this.#token}`;
      response = await this.#fetch(url, {
        ...requestInit,
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ChannelProviderError(
        "channel_transport_unavailable",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    if (response.status === 404 && allowNotFound) return undefined;
    if (!response.ok) {
      throw new ChannelProviderError(
        "channel_http_error",
        `Host returned ${String(response.status)}`,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new ChannelProviderError(
        "channel_protocol_invalid",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }
}

export function httpChannelPlugin(
  provider: ChannelEventSource &
    ChannelMediaSource &
    ChannelSendOperations &
    ChannelContactSource,
): PluginDefinition {
  return {
    name: "http-channel",
    provides: [
      CHANNEL_EVENTS_CAPABILITY,
      CHANNEL_MEDIA_CAPABILITY,
      CHANNEL_SEND_CAPABILITY,
      CHANNEL_CONTACTS_CAPABILITY,
    ],
    requires: [],
    setup(context) {
      context.provide(CHANNEL_EVENTS_CAPABILITY, provider);
      context.provide(CHANNEL_MEDIA_CAPABILITY, provider);
      context.provide(CHANNEL_SEND_CAPABILITY, provider);
      context.provide(CHANNEL_CONTACTS_CAPABILITY, provider);
    },
  };
}

function toChannelContact(
  contact: z.infer<typeof hostContactSchema>,
): ChannelContact {
  return {
    contactRef: contact.contactRef,
    displayName: contact.displayName,
    nickname: contact.nickname,
    remark: contact.remark,
    alias: contact.alias,
    avatarUrl: contact.avatarUrl,
    contactType: contact.contactType,
  };
}

function toChannelEvent(event: z.infer<typeof hostEventSchema>): ChannelEvent {
  return {
    eventId: event.eventId,
    cursor: event.cursor,
    conversationRef: event.conversationRef,
    channelMessageId: event.channelMessageId ?? null,
    senderRef: event.senderRef ?? null,
    kind: event.kind,
    content: event.content,
    mediaRef: event.mediaRef ?? null,
    occurredAt: event.occurredAt ?? null,
    observedAt: event.observedAt,
    isSelf: event.isSelf,
  };
}

function parseSendOperation(value: unknown): ChannelSendOperation {
  try {
    const operation = hostSendOperationSchema.parse(value);
    return {
      operationId: operation.operationId,
      conversationRef: operation.conversationRef,
      payload: operation.payload,
      state: operation.state,
      ...(operation.error ? { error: operation.error } : {}),
      ...(operation.channelMessageId
        ? { channelMessageId: operation.channelMessageId }
        : {}),
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    };
  } catch (error) {
    throw new ChannelProviderError(
      "channel_protocol_invalid",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

function requestHeaders(input: RequestInit["headers"]): Record<string, string> {
  const headers: Record<string, string> = {};
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (input && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  return headers;
}

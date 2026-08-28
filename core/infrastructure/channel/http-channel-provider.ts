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
  ChannelSendPayload,
  CreateChannelSendOperationInput,
} from "../../modules/channel/contracts/channel-send-operations.js";
import { CHANNEL_PROTOCOL } from "../../modules/channel/contracts/channel-send-operations.js";
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
    /** 账号维度（ADR-0005 多账号隔离）；缺省回落 "default" */
    account: z.string().nullable().optional(),
    channelMessageId: z.string().nullable().optional(),
    senderRef: z.string().nullable().optional(),
    kind: z.string().min(1),
    content: z.string(),
    mediaRef: z.string().nullable().optional(),
    fileName: z.string().nullable().optional(),
    mimeType: z.string().nullable().optional(),
    /** 群聊被 @ 提及（ADR-0006）；缺省 = 未提及 */
    mentioned: z.boolean().nullable().optional(),
    /** 入站引用原消息（ADR-0006）；缺省 = 无引用 */
    replyToChannelMessageId: z.string().nullable().optional(),
    /** 历史回溯事件（空库 Backfill，协议 v2）；缺省 = 实时事件 */
    historical: z.boolean().nullable().optional(),
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
    // Store diagnostics (optional, backward compatible): let consumers
    // detect a wiped/rebuilt ledger whose numbering restarted below their
    // watermark (maxCursor) or whose generation changed (epoch).
    maxCursor: z.string().optional(),
    epoch: z.string().optional(),
  })
  .strict();

const hostContactSchema = z
  .object({
    contactRef: z.string().min(1),
    /** 账号维度（ADR-0005 多账号隔离）；缺省回落 "default" */
    account: z.string().nullable().optional(),
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
        kind: z.enum(["text", "reply", "mention", "poke", "image", "file", "recall", "voice"]),
        text: z.string().optional(),
        replyToChannelMessageId: z.string().optional(),
        mentionContactRefs: z.array(z.string()).optional(),
        path: z.string().optional(),
        fileName: z.string().optional(),
      })
      .strict(),
    // executing 是 Channel Host 内部的中间态（已认领、GUI 发送中），
    // 对 Core 语义等价于 pending（仍在途）；缺失会导致 GET 对账时
    // Zod 校验失败并中断整个 outbound cycle。
    state: z.enum(["pending", "executing", "confirmed", "unknown", "failed"]),
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
      | "channel_protocol_invalid"
      | "channel_protocol_mismatch",
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
  /** capabilities 校验结果缓存：undefined = 未校验；false = 协议失配 */
  #protocolOk: boolean | undefined;
  #protocolDetail: string | undefined;

  public constructor(options: HttpChannelProviderOptions) {
    if (!options.token) throw new Error("channel_host_token_required");
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#protocolOk = undefined;
    this.#protocolDetail = undefined;
  }

  /**
   * 协议对账：GET /api/v1/channel/capabilities 与 CHANNEL_PROTOCOL 比对。
   * 失配时抛 channel_protocol_mismatch，调用方（发送循环）应暂停发送、保留队列。
   * 结果缓存；可通过 protocolStatus() 读取（供 doctor/诊断）。
   */
  public async ensureProtocol(): Promise<void> {
    if (this.#protocolOk !== undefined) {
      if (!this.#protocolOk) {
        throw new ChannelProviderError(
          "channel_protocol_mismatch",
          this.#protocolDetail ?? "host protocol mismatch",
        );
      }
      return;
    }
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/api/v1/channel/capabilities`,
        {
          headers: { authorization: `Bearer ${this.#token}` },
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch (error) {
      // host 不可达不判失配——transport 层已有自己的错误语义
      this.#protocolOk = true;
      this.#protocolDetail = "host unreachable; protocol check skipped";
      return;
    }
    let payload: Record<string, unknown> | undefined;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      this.#protocolOk = true;
      this.#protocolDetail = "host returned non-JSON capabilities; check skipped";
      return;
    }
    const problems: string[] = [];
    const version = payload["protocolVersion"];
    if (version !== CHANNEL_PROTOCOL.protocolVersion) {
      problems.push(`protocolVersion ${String(version)} != ${String(CHANNEL_PROTOCOL.protocolVersion)}`);
    }
    const states = new Set(
      Array.isArray(payload["sendOperationStates"]) ? (payload["sendOperationStates"] as string[]) : [],
    );
    for (const state of CHANNEL_PROTOCOL.sendOperationStates) {
      if (!states.has(state)) problems.push(`missing sendOperationState: ${state}`);
    }
    const kinds = new Set(
      Array.isArray(payload["sendKinds"]) ? (payload["sendKinds"] as string[]) : [],
    );
    for (const kind of CHANNEL_PROTOCOL.sendKinds) {
      if (!kinds.has(kind)) problems.push(`missing sendKind: ${kind}`);
    }
    this.#protocolOk = problems.length === 0;
    this.#protocolDetail =
      problems.length === 0
        ? `protocol v${String(version)} in sync`
        : `protocol mismatch: ${problems.join("; ")}`;
    if (!this.#protocolOk) {
      throw new ChannelProviderError(
        "channel_protocol_mismatch",
        this.#protocolDetail,
      );
    }
  }

  /** 只读协议状态（供 dev doctor / 诊断端点） */
  public protocolStatus(): { ok: boolean | undefined; detail: string | undefined } {
    return { ok: this.#protocolOk, detail: this.#protocolDetail };
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
        ...(payload.maxCursor !== undefined
          ? { maxCursor: payload.maxCursor }
          : {}),
        ...(payload.epoch !== undefined ? { epoch: payload.epoch } : {}),
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
    await this.ensureProtocol();
    const response = await this.#request(
      `${this.#baseUrl}/api/v1/channel/send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...input,
          ...(input.account ? { account: input.account } : {}),
        }),
      },
    );
    return parseSendOperation(response);
  }

  public async resolveImage(mediaRef: string): Promise<ChannelMediaResult> {
    return this.#resolveMedia(mediaRef, {
      allowedMimeTypes: ["image/jpeg", "image/png", "image/gif"],
    });
  }

  public async resolveFile(mediaRef: string): Promise<ChannelMediaResult> {
    // 文件附件可以是任意 MIME（PDF、Office、压缩包……），
    // 只要求 Host 返回了明确的 Content-Type。
    return this.#resolveMedia(mediaRef, {});
  }

  public async resolveAudio(mediaRef: string): Promise<ChannelMediaResult> {
    // 语音只接受 Host 明确声明的 SILK 格式（Core 侧二次把关；
    // 其余音频格式由对应 Channel Host 扩展白名单后再放开）。
    return this.#resolveMedia(mediaRef, {
      allowedMimeTypes: ["audio/x-silk"],
    });
  }

  public async resolveVideo(mediaRef: string): Promise<ChannelMediaResult> {
    return this.#resolveMedia(mediaRef, {
      allowedMimeTypes: ["video/mp4"],
    });
  }

  async #resolveMedia(
    mediaRef: string,
    options: { allowedMimeTypes?: string[] },
  ): Promise<ChannelMediaResult> {
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
    if (!mimeType) {
      await response.body.cancel();
      return { state: "failed", errorCode: "media_mime_unsupported" };
    }
    if (
      options.allowedMimeTypes &&
      !options.allowedMimeTypes.includes(mimeType)
    ) {
      await response.body.cancel();
      return { state: "failed", errorCode: "media_mime_unsupported" };
    }
    // X-Media-Variant: thumbnail 表示 Host 以缩略图回退（如微信 AES 密钥
    // 缺失），Core 落盘为展示层并在密钥就绪后升级原图；其余值按 original。
    const variant =
      response.headers.get("x-media-variant") === "thumbnail"
        ? ("thumbnail" as const)
        : ("original" as const);
    return { state: "ready", body: response.body, mimeType, variant };
  }

  public async get(
    operationId: string,
  ): Promise<ChannelSendOperation | undefined> {
    await this.ensureProtocol();
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
    account: contact.account ?? "default",
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
    account: event.account ?? "default",
    channelMessageId: event.channelMessageId ?? null,
    senderRef: event.senderRef ?? null,
    kind: event.kind,
    content: event.content,
    mediaRef: event.mediaRef ?? null,
    fileName: event.fileName ?? null,
    mimeType: event.mimeType ?? null,
    mentioned: event.mentioned ?? null,
    replyToChannelMessageId: event.replyToChannelMessageId ?? null,
    historical: event.historical ?? null,
    occurredAt: event.occurredAt ?? null,
    observedAt: event.observedAt,
    isSelf: event.isSelf,
  };
}

function parseSendOperation(value: unknown): ChannelSendOperation {
  try {
    const operation = hostSendOperationSchema.parse(value);
    const payload: ChannelSendPayload = (() => {
      switch (operation.payload.kind) {
        case "reply":
          return {
            kind: "reply",
            text: operation.payload.text ?? "",
            replyToChannelMessageId:
              operation.payload.replyToChannelMessageId ?? "",
          };
        case "mention":
          return {
            kind: "mention",
            text: operation.payload.text ?? "",
            mentionContactRefs: operation.payload.mentionContactRefs ?? [],
          };
        case "poke":
          return { kind: "poke" };
        case "recall":
          return { kind: "recall" };
        case "voice":
          return { kind: "voice", path: operation.payload.path ?? "" };
        case "image":
          return {
            kind: "image",
            path: operation.payload.path ?? "",
          };
        case "file":
          return {
            kind: "file",
            path: operation.payload.path ?? "",
            ...(operation.payload.fileName
              ? { fileName: operation.payload.fileName }
              : {}),
          };
        default:
          return { kind: "text", text: operation.payload.text ?? "" };
      }
    })();
    return {
      operationId: operation.operationId,
      conversationRef: operation.conversationRef,
      payload,
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

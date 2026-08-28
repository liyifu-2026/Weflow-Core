import { describe, expect, it } from "vitest";
import { HttpChannelProvider } from "../infrastructure/channel/http-channel-provider.js";

function providerWith(respond: (url: string) => Response): HttpChannelProvider {
  const fetchMock = (input: string | URL | globalThis.Request): Response =>
    respond(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
  return new HttpChannelProvider({
    baseUrl: "https://host.test",
    token: "secret",
    fetch: fetchMock as unknown as typeof fetch,
  });
}

describe("HttpChannelProvider file media", () => {
  it("pulls events carrying optional fileName and mimeType", async () => {
    const provider = providerWith((url) => {
      expect(url).toContain("/api/v1/channel/events");
      return Response.json({
        events: [
          {
            eventId: "wechat:room-1:5",
            cursor: "5",
            conversationRef: "room-1",
            channelMessageId: "5",
            senderRef: "wxid-contact",
            kind: "file",
            content: "季度报告.pdf",
            mediaRef: "wechat-media:v1:abc",
            fileName: "季度报告.pdf",
            mimeType: "application/pdf",
            occurredAt: "2026-08-17T00:00:00Z",
            observedAt: "2026-08-17T00:00:01Z",
            isSelf: false,
          },
        ],
        nextCursor: "5",
        hasMore: false,
      });
    });

    const page = await provider.pullEvents({});
    expect(page.events[0]?.kind).toBe("file");
    expect(page.events[0]?.mediaRef).toBe("wechat-media:v1:abc");
  });

  it("pulls historical backfill events preserving the historical flag", async () => {
    const provider = providerWith((url) => {
      expect(url).toContain("/api/v1/channel/events");
      return Response.json({
        events: [
          {
            eventId: "hist:room-1:9",
            cursor: "9",
            conversationRef: "room-1",
            channelMessageId: "9",
            senderRef: "wxid-contact",
            kind: "text",
            content: "历史消息",
            occurredAt: "2026-08-01T00:00:00Z",
            observedAt: "2026-08-27T00:00:00Z",
            isSelf: false,
            historical: true,
          },
        ],
        nextCursor: "9",
        hasMore: false,
      });
    });

    const page = await provider.pullEvents({});
    expect(page.events[0]?.eventId).toBe("hist:room-1:9");
    expect(page.events[0]?.historical).toBe(true);
  });

  it("resolveFile streams non-image mime types", async () => {
    const provider = providerWith(
      () =>
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );
    const result = await provider.resolveFile("wechat-media:v1:abc");
    expect(result.state).toBe("ready");
    if (result.state === "ready") {
      expect(result.mimeType).toBe("application/pdf");
      await result.body.cancel();
    }
  });

  it("resolveFile maps pending, not_found, and failure statuses", async () => {
    const statuses: [number, string, string][] = [
      [202, "pending", ""],
      [404, "not_found", ""],
      [422, "failed", "media_unreadable"],
    ];
    for (const [status, state, errorCode] of statuses) {
      const provider = providerWith(() =>
        status === 422
          ? Response.json({ error: "media_unreadable" }, { status })
          : new Response(null, { status }),
      );
      const result = await provider.resolveFile(`ref-${String(status)}`);
      expect(result.state).toBe(state);
      if (result.state === "failed") {
        expect(result.errorCode).toBe(errorCode);
      }
    }
  });

  it("resolveAudio streams SILK voice and rejects non-audio mime types", async () => {
    const provider = providerWith(
      () =>
        new Response(new Uint8Array([0x02, 0x23, 0x21]), {
          status: 200,
          headers: { "content-type": "audio/x-silk" },
        }),
    );
    const ready = await provider.resolveAudio("wechat-media:v1:voice-1");
    expect(ready.state).toBe("ready");
    if (ready.state === "ready") {
      expect(ready.mimeType).toBe("audio/x-silk");
      await ready.body.cancel();
    }

    const rejecting = providerWith(
      () =>
        new Response(new Uint8Array([0x01]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );
    const failed = await rejecting.resolveAudio("wechat-media:v1:voice-2");
    expect(failed).toMatchObject({
      state: "failed",
      errorCode: "media_mime_unsupported",
    });
  });

  it("resolveImage still rejects non-image mime types", async () => {
    const provider = providerWith(
      () =>
        new Response(new Uint8Array([0x01]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );
    const result = await provider.resolveImage("wechat-media:v1:abc");
    expect(result).toMatchObject({
      state: "failed",
      errorCode: "media_mime_unsupported",
    });
  });

  it("resolveImage maps X-Media-Variant thumbnail and defaults to original", async () => {
    const thumbnailProvider = providerWith(
      () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "x-media-variant": "thumbnail",
          },
        }),
    );
    const thumbnail = await thumbnailProvider.resolveImage("ref-thumb");
    expect(thumbnail).toMatchObject({
      state: "ready",
      mimeType: "image/jpeg",
      variant: "thumbnail",
    });
    if (thumbnail.state === "ready") await thumbnail.body.cancel();

    const plainProvider = providerWith(
      () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const plain = await plainProvider.resolveImage("ref-plain");
    expect(plain).toMatchObject({ state: "ready", variant: "original" });
    if (plain.state === "ready") await plain.body.cancel();

    // 非法变体值按 original 处理，不破坏同步
    const invalidProvider = providerWith(
      () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "x-media-variant": "hires",
          },
        }),
    );
    const invalid = await invalidProvider.resolveImage("ref-invalid");
    expect(invalid).toMatchObject({ state: "ready", variant: "original" });
    if (invalid.state === "ready") await invalid.body.cancel();
  });
});

describe("HttpChannelProvider protocol reconciliation", () => {
  // 协议 v4：出站新增 recall + 受限 voice(video)
  const matchingCapabilities = {
    protocolVersion: 4,
    sendOperationStates: ["pending", "executing", "confirmed", "unknown", "failed"],
    sendKinds: ["text", "file", "image", "reply", "mention", "poke", "recall", "voice"],
  };

  it("matching capabilities pass without error", async () => {
    const provider = providerWith((url) => {
      expect(url).toContain("/api/v1/channel/capabilities");
      return Response.json(matchingCapabilities);
    });
    await expect(provider.ensureProtocol()).resolves.toBeUndefined();
    expect(provider.protocolStatus().ok).toBe(true);
  });

  it("version mismatch rejects with channel_protocol_mismatch", async () => {
    const provider = providerWith(() =>
      Response.json({ ...matchingCapabilities, protocolVersion: 99 }),
    );
    await expect(provider.ensureProtocol()).rejects.toThrow(
      /channel_protocol_mismatch: protocol mismatch: protocolVersion 99 != 4/,
    );
    expect(provider.protocolStatus().ok).toBe(false);
  });

  it("missing enum members reject and name the gaps", async () => {
    const provider = providerWith(() =>
      Response.json({
        ...matchingCapabilities,
        sendOperationStates: ["pending", "confirmed"],
        sendKinds: ["text"],
      }),
    );
    await expect(provider.ensureProtocol()).rejects.toThrow(
      /missing sendOperationState: executing/,
    );
    await expect(provider.ensureProtocol()).rejects.toThrow(/missing sendKind: file/);
  });

  it("unreachable host skips check instead of failing", async () => {
    const provider = providerWith(() => {
      throw new Error("connection refused");
    });
    await expect(provider.ensureProtocol()).resolves.toBeUndefined();
    expect(provider.protocolStatus().ok).toBe(true);
  });

  it("create() pauses sending when protocol mismatches (queue retained)", async () => {
    let sendCalls = 0;
    const provider = new HttpChannelProvider({
      baseUrl: "https://host.test",
      token: "secret",
      fetch: (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/api/v1/channel/send")) sendCalls += 1;
        return Response.json({ ...matchingCapabilities, protocolVersion: 9 });
      }) as unknown as typeof fetch,
    });
    await expect(
      provider.create({
        operationId: "op-1",
        conversationRef: "room-1",
        payload: { kind: "text", text: "hi" },
      }),
    ).rejects.toThrow(/channel_protocol_mismatch/);
    expect(sendCalls).toBe(0); // 未触达发送端点 → 队列保留
    expect(provider.protocolStatus().ok).toBe(false);
  });
});

/**
 * 非客户方向（自消息回声）媒体的派生阶段终态化集成测试。
 *
 * 事故背景（2026-09-20 X230）：图片/语音描述路径的回声护栏在读到
 * direction!=inbound 时直接 return，媒体永远停在 processing_queued；
 * dispatcher 每轮按该状态重投，同一批自消息图片空转数小时（每秒一次
 * 队列投递 + 日志刷屏）。这里固定住修复后的语义：
 * - 非 inbound：直接 ready（可查看、无描述/转写、不调用模型、不建 Turn）
 * - inbound：既有描述路径不受影响
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStorage } from "../infrastructure/file_storage/local-file-storage.js";
import { createLogger } from "../infrastructure/observability/logger.js";
import {
  createPostgres,
  type Postgres,
} from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";
import { MimoVisionClient } from "../infrastructure/model_runtime/mimo-vision-client.js";
import type { ChannelMediaSource } from "../modules/channel/contracts/channel-media-source.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import { processImageDescription } from "../modules/media/application/process-image-description.js";
import { processVoiceTranscription } from "../modules/media/application/process-voice-transcription.js";
import { syncChannelMedia } from "../modules/media/application/sync-channel-media.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const SILK_BYTES = Buffer.from([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b]);

/** 只要被调用就失败的视觉客户端：非 inbound 媒体不该触达模型 */
function forbiddingVisionClient(): {
  client: MimoVisionClient;
  calls: number[];
} {
  const calls: number[] = [];
  const client = new MimoVisionClient({
    baseUrl: "https://vision.invalid/v1",
    apiKey: "secret-vision-key",
    model: "mimo-v2.5",
    timeoutMs: 1_000,
    fetch: (() => {
      calls.push(Date.now());
      throw new Error("vision must not be called for non-inbound media");
    }) as unknown as typeof globalThis.fetch,
  });
  return { client, calls };
}

function forbiddingAsrClient(): { client: never; calls: number[] } {
  const calls: number[] = [];
  const client = {
    transcribe: () => {
      calls.push(Date.now());
      throw new Error("asr must not be called for non-inbound media");
    },
  };
  return { client: client as never, calls };
}

integration("非 inbound 媒体的派生阶段终态化", () => {
  let postgres: Postgres;
  let root: string;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "weflow-non-inbound-"));
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "non-inbound-media-test"),
    );
  });

  afterAll(async () => {
    await postgres.db
      .delete(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, `channel:echo-${suffix}`));
    await postgres.db
      .delete(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, `channel:echo-${suffix}`));
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(
        eq(schema.memoryCaptureStates.conversationId, `channel:echo-${suffix}`),
      );
    await postgres.db
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, `channel:echo-${suffix}`));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, `channel:echo-${suffix}`));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(
        eq(schema.contactProfiles.contactId, `contact:channel:echo-${suffix}`),
      );
    await postgres.close();
    await rm(root, { recursive: true, force: true });
  });

  async function seedMedia(options: {
    tag: string;
    kind: "image" | "voice";
    isSelf: boolean;
    cursor: string;
  }): Promise<{ mediaId: string; messageId: string }> {
    const conversationRef = `echo-${suffix}`;
    const eventId = `channel:${conversationRef}:${options.tag}`;
    const messageId = `channel:${eventId}`;
    const mediaRef = `channel-media:v1:${suffix}-${options.tag}`;
    const bytes = options.kind === "image" ? IMAGE_BYTES : SILK_BYTES;
    await ingestChannelEvents(
      postgres.db,
      [
        {
          eventId,
          cursor: options.cursor,
          conversationRef,
          channelMessageId: `opaque-${options.tag}`,
          senderRef: "wxid-contact",
          kind: options.kind,
          content: options.kind === "image" ? "[image]" : "",
          mediaRef,
          mimeType: options.kind === "image" ? "image/jpeg" : "audio/x-silk",
          occurredAt: "2026-09-20T11:00:00Z",
          observedAt: "2026-09-20T11:00:01Z",
          isSelf: options.isSelf,
        },
      ],
      options.cursor,
    );
    const source: ChannelMediaSource = {
      resolveImage: () => {
        if (options.kind !== "image")
          throw new Error("unexpected resolveImage");
        const body = new Response(bytes).body;
        if (!body) throw new Error("image body unavailable");
        return Promise.resolve({
          state: "ready",
          body,
          mimeType: "image/jpeg",
        });
      },
      resolveFile: () => {
        throw new Error("unexpected resolveFile");
      },
      resolveAudio: () => {
        if (options.kind !== "voice")
          throw new Error("unexpected resolveAudio");
        const body = new Response(bytes).body;
        if (!body) throw new Error("audio body unavailable");
        return Promise.resolve({
          state: "ready",
          body,
          mimeType: "audio/x-silk",
        });
      },
    };
    await syncChannelMedia(postgres.db, new LocalFileStorage(root), source);
    const [asset] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    if (!asset) throw new Error(`asset missing for ${options.tag}`);
    expect(asset.status).toBe("processing_queued");
    return { mediaId: asset.mediaId, messageId };
  }

  it("自消息图片直接终态化：不调模型、不建 Turn、状态离开处理阶段", async () => {
    const { mediaId, messageId } = await seedMedia({
      tag: "self-image",
      kind: "image",
      isSelf: true,
      cursor: "101",
    });
    const { client, calls } = forbiddingVisionClient();

    await processImageDescription(
      postgres.db,
      new LocalFileStorage(root),
      client,
      "mimo-v2.5",
      mediaId,
    );

    const [asset] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    expect(calls).toHaveLength(0);
    expect(asset?.status).toBe("ready");
    expect(asset?.description).toBeNull();
    expect(asset?.errorCode).toBeNull();
    expect(asset?.originalFileId).not.toBeNull();
    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.triggerMessageId, messageId));
    expect(turns).toHaveLength(0);

    // 再跑一次（dispatcher 重投的形态）必须幂等且不再变化
    await processImageDescription(
      postgres.db,
      new LocalFileStorage(root),
      client,
      "mimo-v2.5",
      mediaId,
    );
    expect(calls).toHaveLength(0);
  });

  it("自消息语音同样终态化", async () => {
    // 出站回声只为 image/file/video 建资产（语音回声根本不进媒体流水线），
    // 这里以「入站建资产 + 方向翻成 outbound」精确构造护栏命中态。
    const { mediaId, messageId } = await seedMedia({
      tag: "self-voice",
      kind: "voice",
      isSelf: false,
      cursor: "102",
    });
    await postgres.db
      .update(schema.messages)
      .set({ direction: "outbound" })
      .where(eq(schema.messages.messageId, messageId));
    const { client, calls } = forbiddingAsrClient();

    await processVoiceTranscription(
      postgres.db,
      new LocalFileStorage(root),
      client,
      "mimo-v2.5-asr",
      mediaId,
      { transcoder: undefined },
    );

    const [asset] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    expect(calls).toHaveLength(0);
    expect(asset?.status).toBe("ready");
    expect(asset?.description).toBeNull();
    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.triggerMessageId, messageId));
    expect(turns).toHaveLength(0);
  });

  it("客户方向（inbound）仍走原描述路径：ready + 描述 + Turn", async () => {
    const { mediaId, messageId } = await seedMedia({
      tag: "customer-image",
      kind: "image",
      isSelf: false,
      cursor: "103",
    });
    const client = new MimoVisionClient({
      baseUrl: "https://vision.invalid/v1",
      apiKey: "secret-vision-key",
      model: "mimo-v2.5",
      timeoutMs: 1_000,
      fetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "客户发来的截图。" } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )) as unknown as typeof globalThis.fetch,
    });

    await processImageDescription(
      postgres.db,
      new LocalFileStorage(root),
      client,
      "mimo-v2.5",
      mediaId,
    );

    const [asset] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    expect(asset?.status).toBe("ready");
    expect(asset?.description).toBe("客户发来的截图。");
    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.triggerMessageId, messageId));
    expect(turns).toHaveLength(1);
  });
});

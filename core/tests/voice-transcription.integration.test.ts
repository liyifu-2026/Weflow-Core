/**
 * 语音转写（备选 ASR 路径）集成测试
 *
 * 覆盖：
 * - SILK 下载落盘 → 转码 MP3 → ASR 中文转写 → media ready + Agent Turn（幂等）
 * - ASR 失败：回退 processing_queued（asr_request_failed），交由队列有界重试
 * - 转码工具缺失：终态失败（transcode_unavailable），不无限重试，
 *   由 createDegradedTurns 兜底创建降级 Turn（消息不静默）
 * - 重试耗尽（retry_exhausted）→ 降级 Turn → 上下文渲染"转写不可用"占位
 * - 任何路径不把本地路径/密钥暴露到错误码与上层错误消息
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
import { MimoAudioClient } from "../infrastructure/model_runtime/mimo-audio-client.js";
import type { ChannelMediaSource } from "../modules/channel/contracts/channel-media-source.js";
import { buildAgentContext } from "../modules/agent/application/agent-context.js";
import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";
import { processVoiceTranscription } from "../modules/media/application/process-voice-transcription.js";
import { syncChannelMedia } from "../modules/media/application/sync-channel-media.js";
import { readRuntimeSettings } from "../modules/operations/application/runtime-settings.js";
import {
  createDegradedTurns,
  failMediaVisionDisabled,
} from "../infrastructure/redis/media-processing-dispatcher.js";
import { failMediaVoiceWithoutAsr } from "../infrastructure/redis/media-processing-dispatcher.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const SILK_BYTES = Buffer.from([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b]);
const MP3_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01]);

function fakeAsrClient(options: {
  transcription?: string;
  failWith?: number;
}): {
  client: MimoAudioClient;
  requests: { mime: string; body: string }[];
} {
  const requests: { mime: string; body: string }[] = [];
  const client = new MimoAudioClient({
    baseUrl: "https://asr.invalid/v1",
    apiKey: "secret-asr-key",
    model: "mimo-v2.5-asr",
    timeoutMs: 1_000,
    fetch: ((_input: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const mime = /data:([^;]+);/.exec(body)?.[1] ?? "";
      requests.push({ mime, body });
      if (options.failWith) {
        return Promise.resolve(
          new Response("upstream boom", { status: options.failWith }),
        );
      }
      return Promise.resolve(
        Response.json({
          choices: [{ message: { content: options.transcription ?? "好的" } }],
        }),
      );
    }) as unknown as typeof fetch,
  });
  return { client, requests };
}

function silkTranscoder() {
  const seen: Buffer[] = [];
  return {
    seen,
    transcoder: {
      transcodeToMp3: (input: Buffer) => {
        seen.push(Buffer.from(input));
        return Promise.resolve(MP3_BYTES);
      },
    },
  };
}

integration("voice transcription pipeline（SILK→MP3→ASR）", () => {
  let postgres: Postgres;
  let root: string;
  const suffix = `${String(Date.now())}-${String(process.pid)}`;
  const conversationRef = `voice-asr-${suffix}`;
  const conversationId = `channel:${conversationRef}`;
  const contactId = `contact:channel:${conversationRef}`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "weflow-voice-asr-"));
    postgres = createPostgres(
      databaseUrl ?? "",
      createLogger({ logLevel: "silent" }, "voice-asr-test"),
    );
  });

  afterAll(async () => {
    const assets = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, conversationId));
    const fileIds = assets
      .map((asset) => asset.originalFileId)
      .filter((fileId): fileId is string => Boolean(fileId));
    await postgres.db
      .delete(schema.mediaAssets)
      .where(eq(schema.mediaAssets.conversationId, conversationId));
    for (const fileId of fileIds) {
      await postgres.db
        .delete(schema.storedFiles)
        .where(eq(schema.storedFiles.fileId, fileId));
    }
    await postgres.db
      .delete(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, conversationId));
    await postgres.db
      .delete(schema.memoryCaptureStates)
      .where(eq(schema.memoryCaptureStates.conversationId, conversationId));
    await postgres.db
      .delete(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    await postgres.db
      .delete(schema.conversations)
      .where(eq(schema.conversations.conversationId, conversationId));
    await postgres.db
      .delete(schema.contactProfiles)
      .where(eq(schema.contactProfiles.contactId, contactId));
    await postgres.close();
    await rm(root, { recursive: true, force: true });
  });

  /** ingest 无转写语音 + sync 落盘 SILK，返回 { mediaId, messageId } */
  async function seedSilkVoice(tag: string): Promise<{
    mediaId: string;
    messageId: string;
  }> {
    const eventId = `channel:${conversationRef}:${tag}`;
    const messageId = `channel:${eventId}`;
    const mediaRef = `wechat-media:v1:${suffix}-${tag}`;
    const cursor = String((Date.now() % 1_000_000_000) + tag.length);
    await ingestChannelEvents(
      postgres.db,
      [
        {
          eventId,
          cursor,
          conversationRef,
          channelMessageId: `opaque-${tag}`,
          senderRef: "wxid-contact",
          kind: "voice",
          content: "",
          mediaRef,
          mimeType: "audio/x-silk",
          occurredAt: "2026-08-23T00:00:00Z",
          observedAt: "2026-08-23T00:00:01Z",
          isSelf: false,
        },
      ],
      cursor,
    );
    const [asset] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.messageId, messageId));
    if (!asset) throw new Error(`voice asset missing for ${tag}`);
    const storage = new LocalFileStorage(root);
    const source: ChannelMediaSource = {
      resolveImage: () => {
        throw new Error("voice assets must not use resolveImage");
      },
      resolveFile: () => {
        throw new Error("voice assets must not use resolveFile");
      },
      resolveAudio: (ref) => {
        expect(ref).toBe(mediaRef);
        const body = new Response(SILK_BYTES).body;
        if (!body) throw new Error("audio body unavailable");
        return Promise.resolve({
          state: "ready",
          body,
          mimeType: "audio/x-silk",
        });
      },
    };
    await syncChannelMedia(postgres.db, storage, source);
    return { mediaId: asset.mediaId, messageId };
  }

  it("转码成功 → ASR 中文转写 → ready + Agent Turn（幂等）", async () => {
    const { mediaId, messageId } = await seedSilkVoice("happy");
    const { transcoder, seen } = silkTranscoder();
    const asr = fakeAsrClient({ transcription: "明天上午十点开会" });
    const storage = new LocalFileStorage(root);

    await processVoiceTranscription(
      postgres.db,
      storage,
      asr.client,
      "mimo-v2.5-asr",
      mediaId,
      { transcoder },
    );
    // 幂等：重复处理不产生第二个 Turn、不重复请求 ASR
    await processVoiceTranscription(
      postgres.db,
      storage,
      asr.client,
      "mimo-v2.5-asr",
      mediaId,
      { transcoder },
    );

    const [media] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    expect(media).toMatchObject({
      status: "ready",
      description: "明天上午十点开会",
      descriptionModel: "mimo-v2.5-asr",
      errorCode: null,
    });

    // 转码器收到 SILK 原始字节；ASR 收到 MP3 且 MIME 为 audio/mpeg
    expect(seen[0]?.equals(SILK_BYTES)).toBe(true);
    expect(asr.requests[0]).toMatchObject({ mime: "audio/mpeg" });

    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.triggerMessageId, messageId));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "queued" });
  });

  it("ASR 失败 → processing_queued + asr_request_failed（有界重试语义）", async () => {
    const { mediaId } = await seedSilkVoice("asr-fail");
    const { transcoder } = silkTranscoder();
    const failing = fakeAsrClient({ failWith: 500 });

    await expect(
      processVoiceTranscription(
        postgres.db,
        new LocalFileStorage(root),
        failing.client,
        "mimo-v2.5-asr",
        mediaId,
        { transcoder },
      ),
    ).rejects.toThrow(/audio API returned 500/);

    const [media] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    expect(media).toMatchObject({
      status: "processing_queued",
      errorCode: "asr_request_failed",
    });
    // 错误码与持久化状态不暴露本地路径与上游密钥
    expect(media?.errorCode ?? "").not.toContain(root);
    expect(JSON.stringify(media)).not.toContain("secret-asr-key");
  });

  it("转码工具缺失 → 终态 transcode_unavailable，不重试，降级 Turn 兜底", async () => {
    const { mediaId } = await seedSilkVoice("no-transcoder");
    const unusedAsr = fakeAsrClient({ transcription: "不应被调用" });

    // 不抛错、不触发 ASR：诚实终态
    await processVoiceTranscription(
      postgres.db,
      new LocalFileStorage(root),
      unusedAsr.client,
      "mimo-v2.5-asr",
      mediaId,
      { transcoder: undefined },
    );

    expect(unusedAsr.requests).toHaveLength(0);
    const [media] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    expect(media).toMatchObject({
      status: "failed",
      errorCode: "transcode_unavailable",
    });

    const created = await createDegradedTurns(
      postgres.db,
      createLogger({ logLevel: "silent" }, "voice-asr-test"),
      readRuntimeSettings,
    );
    expect(created).toBeGreaterThanOrEqual(1);
  });

  it("重试耗尽（retry_exhausted）→ 降级 Turn → 上下文渲染转写不可用占位", async () => {
    const { mediaId, messageId } = await seedSilkVoice("exhausted");
    await postgres.db
      .update(schema.mediaAssets)
      .set({
        status: "failed",
        errorCode: "retry_exhausted",
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAssets.mediaId, mediaId));

    await createDegradedTurns(
      postgres.db,
      createLogger({ logLevel: "silent" }, "voice-asr-test"),
      readRuntimeSettings,
    );

    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.triggerMessageId, messageId));
    expect(turns).toHaveLength(1);

    const context = await buildAgentContext(postgres.db, conversationId);
    const rendered = JSON.stringify(context.history);
    expect(rendered).toContain("[对方发来一条语音，转写不可用]");
  });

  it("ASR 未配置：语音处理阶段短路失败（asr_not_configured），降级 Turn 兜底", async () => {
    const { mediaId } = await seedSilkVoice("asr-not-configured");
    // 模拟已下载、等待转写
    await postgres.db
      .update(schema.mediaAssets)
      .set({ status: "processing_queued", updatedAt: new Date() })
      .where(eq(schema.mediaAssets.mediaId, mediaId));

    const failed = await failMediaVoiceWithoutAsr(
      postgres.db,
      createLogger({ logLevel: "silent" }, "voice-asr-test"),
    );
    expect(failed).toBeGreaterThanOrEqual(1);
    const [media] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    expect(media).toMatchObject({
      status: "failed",
      errorCode: "asr_not_configured",
    });

    const created = await createDegradedTurns(
      postgres.db,
      createLogger({ logLevel: "silent" }, "voice-asr-test"),
      readRuntimeSettings,
    );
    expect(created).toBeGreaterThanOrEqual(1);
  });

  it("运营关闭多模态（vision_enabled=false）：语音与图片同样进入人工路径", async () => {
    const { mediaId, messageId } = await seedSilkVoice("vision-disabled");
    await postgres.db
      .update(schema.mediaAssets)
      .set({ status: "processing_queued", updatedAt: new Date() })
      .where(eq(schema.mediaAssets.mediaId, mediaId));

    const routed: string[] = [];
    await failMediaVisionDisabled(
      postgres.db,
      createLogger({ logLevel: "silent" }, "voice-asr-test"),
      ({ messageId: routedMessageId }) => {
        routed.push(routedMessageId);
        return Promise.resolve();
      },
    );

    const [media] = await postgres.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    expect(media?.status).toBe("failed");
    expect(media?.errorCode).toBe("vision_disabled");
    // 语音消息被幂等路由到人工路径（不静默、也不交给 Agent）
    expect(routed).toContain(messageId);

    // vision_disabled 的媒体不创建降级 Turn（已进人工路径）
    await createDegradedTurns(
      postgres.db,
      createLogger({ logLevel: "silent" }, "voice-asr-test"),
      readRuntimeSettings,
    );
    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.triggerMessageId, messageId));
    expect(turns).toHaveLength(0);
  });

  it("历史 legacy_voice_unsupported 失败行也纳入降级 Turn 扫描", async () => {
    const { mediaId, messageId } = await seedSilkVoice("legacy");
    await postgres.db
      .update(schema.mediaAssets)
      .set({
        status: "failed",
        errorCode: "legacy_voice_unsupported",
        updatedAt: new Date(),
      })
      .where(eq(schema.mediaAssets.mediaId, mediaId));

    const created = await createDegradedTurns(
      postgres.db,
      createLogger({ logLevel: "silent" }, "voice-asr-test"),
      readRuntimeSettings,
    );
    expect(created).toBeGreaterThanOrEqual(1);
    const turns = await postgres.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.triggerMessageId, messageId));
    expect(turns).toHaveLength(1);
  });
});

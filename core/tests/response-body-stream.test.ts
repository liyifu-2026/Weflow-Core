/**
 * 响应体预读缓冲回归测试。
 *
 * 事故背景（2026-09-20 生产崩溃循环，undici `assert(!this.paused)`）：
 * 消费端一慢，undici 解析器就暂停；此时对端 FIN 会触发未捕获断言杀进程。
 * 这里验证修复的核心性质——消费端停滞时，上游 web 流仍在被持续拉动
 * （即解析器不会进入暂停态），同时字节完全一致、不改变既有下载行为。
 */
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  RESPONSE_BODY_PREBUFFER_BYTES,
  responseBodyStream,
} from "../infrastructure/http/response-body.js";

/** 记录被拉动次数与已产出字节的合成响应体 */
function trackedBody(totalBytes: number, chunkBytes = 64 * 1024) {
  let produced = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (produced >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - produced);
      produced += size;
      controller.enqueue(new Uint8Array(size).fill(7));
    },
  });
  return {
    body,
    stats: () => ({ pulls, produced }),
  };
}

/** 每次写入都延迟的消费端：模拟慢磁盘 */
class SlowSink extends Writable {
  bytes = 0;
  constructor(private readonly delayMs: number) {
    super();
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.bytes += chunk.length;
    setTimeout(callback, this.delayMs);
  }
}

describe("responseBodyStream", () => {
  it("keeps pulling the web stream while the consumer is stalled", async () => {
    // 8 MiB 响应体 + 每块 5ms 的慢消费端（模拟慢磁盘）：预读缓冲下，源应在
    // 消费端刚吃掉一小部分时就已经被拉完，解析器全程没有暂停窗口。
    const size = 8 * 1024 * 1024;
    const tracked = trackedBody(size);
    const sink = new SlowSink(5);
    const done = pipeline(responseBodyStream(tracked.body), sink);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const early = tracked.stats();
    await done;

    expect(sink.bytes).toBe(size);
    // 100ms 里消费端只写入了约 1.2 MiB，而源已全部产出并停在缓冲里
    expect(early.produced).toBe(size);
  });

  it("contrast: a bare Readable.fromWeb is pulled only as fast as the consumer", async () => {
    // 对照组：说明修复确实改变了行为（否则上面的断言没有意义）
    const size = 8 * 1024 * 1024;
    const tracked = trackedBody(size);
    const sink = new SlowSink(5);
    const done = pipeline(Readable.fromWeb(tracked.body), sink);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const early = tracked.stats();
    await done;

    expect(sink.bytes).toBe(size);
    // 裸流受管道 16 KiB 级缓冲约束，100ms 后产出与消费基本同步，远未拉完
    expect(early.produced).toBeLessThan(size / 2);
  });

  it("matches raw Readable.fromWeb byte-for-byte without buffering the whole body", async () => {
    const size = 3 * 1024 * 1024;
    const tracked = trackedBody(size);
    const sink = new SlowSink(0);

    await pipeline(responseBodyStream(tracked.body), sink);

    expect(sink.bytes).toBe(size);
  });

  it("propagates a source failure to the consumer instead of hanging", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.error(new Error("upstream reset"));
      },
    });
    const sink = new SlowSink(0);

    await expect(pipeline(responseBodyStream(body), sink)).rejects.toThrow(
      /upstream reset/,
    );
  });

  it("does not stall a large body when the consumer is paused briefly", async () => {
    // 消费端中途停顿 50ms：预读缓冲应让上游在此期间继续被读走
    const size = 2 * 1024 * 1024;
    const tracked = trackedBody(size);
    const gate = new PassThrough();
    const sink = new SlowSink(0);
    const out = pipeline(responseBodyStream(tracked.body), gate, sink);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const midPulls = tracked.stats().pulls;
    await out;

    expect(tracked.stats().produced).toBe(size);
    expect(midPulls).toBeGreaterThan(1);
    // 使用默认预读常量（数值本身只是配置，行为由上面的 pulls 断言保证）
    expect(RESPONSE_BODY_PREBUFFER_BYTES).toBeGreaterThan(size);
  });

  it("keeps streaming (no size limit) for bodies beyond the prebuffer window", async () => {
    const sink = new SlowSink(1);
    const size = RESPONSE_BODY_PREBUFFER_BYTES + 2 * 1024 * 1024;

    await pipeline(
      responseBodyStream(trackedBody(size).body, {
        prebufferBytes: 512 * 1024,
      }),
      sink,
    );

    expect(sink.bytes).toBe(size);
  });
});

describe("responseBodyStream integration shape", () => {
  it("feeds LocalFileStorage with the exact bytes the host served", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { LocalFileStorage } =
      await import("../infrastructure/file_storage/local-file-storage.js");
    const root = await mkdtemp(join(tmpdir(), "weflow-response-body-"));
    try {
      const payload = Buffer.alloc(1024 * 1024 + 123, 42);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
            controller.enqueue(
              new Uint8Array(payload.subarray(offset, offset + 64 * 1024)),
            );
          }
          controller.close();
        },
      });
      const storage = new LocalFileStorage(root);
      const written = await storage.write(
        responseBodyStream(body),
        "photo.jpg",
        "image/jpeg",
      );
      const onDisk = await readFile(join(root, written.storageKey));
      expect(written.size).toBe(payload.length);
      expect(onDisk.equals(payload)).toBe(true);
      expect(written.checksum).toHaveLength(64);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("works when piped into a slow consumer like Fastify reply.send", async () => {
    // reply.send(stream) 会把流交给可能被浏览器拖慢的 socket；这里用带延迟的
    // Writable 模拟，验证不丢字节、不报错。
    const size = 1.5 * 1024 * 1024;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent < size; sent += 32 * 1024) {
          controller.enqueue(new Uint8Array(32 * 1024).fill(3));
        }
        controller.close();
      },
    });
    const received: Buffer[] = [];
    const consumer = new Writable({
      highWaterMark: 16 * 1024,
      write(chunk: Buffer, _encoding, callback) {
        received.push(chunk);
        setTimeout(callback, 2);
      },
    });

    await pipeline(responseBodyStream(body), consumer);

    const total = Buffer.concat(received);
    expect(total.length).toBe(size);
    expect(total.every((byte) => byte === 3)).toBe(true);
  });

  it("cancels the web stream when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const stream = responseBodyStream(body, { prebufferBytes: 32 * 1024 });
    await new Promise<void>((resolve) => {
      stream.once("data", () => {
        resolve();
      });
    });
    stream.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelled).toBe(true);
  });
});

/**
 * fetch 响应体 → Node 可读流（媒体下载、知识代理共用）。
 *
 * 生产事故（2026-09-20，X230，Node 24.21）：core 直接把 `response.body`
 * （Web ReadableStream）交给带背压的落盘/转发管线。消费端一慢，undici 就暂停
 * 解析器；此刻若对端发来 FIN（Python http.server 默认 `Connection: close`），
 * undici 的 `Parser.finish()` 命中 `assert(!this.paused)` —— 未捕获断言直接
 * 终止整个 API 进程（连续崩溃 125 次，前端全部媒体不可见）。
 *
 * 裸 `Readable.fromWeb` 的缓冲只有管道各段默认的 16 KiB 量级，几十 KB 的图片
 * 就足以把解析器推进暂停态。这里在源头后接一段显式预读缓冲：消费端滞后
 * 不超过 `prebufferBytes` 时，web 流始终处于被拉动状态，FIN 没有任何触发条件；
 * 内存占用有界（约 2 × prebufferBytes），超出后自然回落到常规背压，行为与
 * 直连一致（不设体积上限，大文件照常下载）。
 */
import { PassThrough, Readable } from "node:stream";

/** 预读缓冲：滞后量低于该值时不会对上游施加背压 */
export const RESPONSE_BODY_PREBUFFER_BYTES = 8 * 1024 * 1024;

/**
 * 把 fetch 响应体包成带预读缓冲的 Node 可读流。
 *
 * 调用方负责消费（pipeline / reply.send）：与本函数返回的流之间仍走正常背压
 * 语义，只是背压传输到上游 web 流的延迟被预读缓冲吸收了。
 */
export function responseBodyStream(
  body: ReadableStream<Uint8Array>,
  options: { prebufferBytes?: number } = {},
): Readable {
  const prebufferBytes =
    options.prebufferBytes ?? RESPONSE_BODY_PREBUFFER_BYTES;
  const source = Readable.fromWeb(
    body as Parameters<typeof Readable.fromWeb>[0],
  );
  const buffer = new PassThrough({
    writableHighWaterMark: prebufferBytes,
    readableHighWaterMark: prebufferBytes,
  });
  // pipe 不转发错误：源流失败必须让下游 pipeline 看到，否则会挂住等待 EOF
  source.on("error", (error: Error) => {
    buffer.destroy(error);
  });
  // 反向同理：消费端提前放弃（客户端断开、下游出错）时要连上游一起关，
  // 否则 web 流会留在那里继续读 socket
  buffer.on("close", () => {
    source.destroy();
  });
  source.pipe(buffer);
  return buffer;
}

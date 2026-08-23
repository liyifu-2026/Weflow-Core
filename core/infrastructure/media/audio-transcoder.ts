/**
 * SILK → MP3 音频转码器（平台媒体处理基础设施）。
 *
 * 微信等通道的语音以 SILK 编码到达，MiMo ASR 只接受 mp3/flac/m4a/wav/ogg。
 * 默认实现串联系统工具链：pysilk（SILK 解码为 PCM）→ ffmpeg（PCM 编码为 MP3）。
 * 两个可执行文件任一缺失即抛 transcode_unavailable，由上层走诚实降级，
 * 绝不静默；错误消息只含固定文案与退出码，不暴露本地路径或上游密钥。
 */
import { spawn } from "node:child_process";

export type TranscodeErrorCode = "transcode_unavailable" | "transcode_failed";

/** 平台媒体层的转码接缝：上层只依赖本接口，便于注入与替换实现 */
export interface SilkToMp3Transcoder {
  transcodeToMp3(input: Buffer): Promise<Buffer>;
}

export class AudioTranscodeError extends Error {
  public constructor(
    public readonly code: TranscodeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AudioTranscodeError";
  }
}

export type SpawnedProcess = {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  exitCode: number | null;
  killed: boolean;
  kill(): boolean;
};

/** 与 node:child_process.spawn 同签名；测试注入假实现 */
export type SpawnProcess = (
  command: string,
  args: readonly string[],
) => SpawnedProcess;

export type PysilkFfmpegTranscoderOptions = {
  pythonPath?: string;
  ffmpegPath?: string;
  /** pysilk 解码采样率；微信语音原生 24kHz */
  sampleRate?: number;
  timeoutMs?: number;
  spawnImpl?: SpawnProcess;
  /** 完整诊断（stderr 等）只经此回调输出到服务端日志，不进入 Error 消息 */
  onDiagnostics?: (line: string) => void;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 20;

/** 解码阶段：stdin=SILK，stdout=PCM s16le；pysilk 调用内联避免额外脚本文件 */
const DECODE_SCRIPT =
  "import io,sys,pysilk;" +
  "data=sys.stdin.buffer.read();" +
  "out=io.BytesIO();" +
  "pysilk.decode(io.BytesIO(data),out,%d);" +
  "sys.stdout.buffer.write(out.getvalue())";

function encodeArgs(sampleRate: number): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    String(sampleRate),
    "-ac",
    "1",
    "-i",
    "pipe:0",
    "-f",
    "mp3",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "64k",
    "pipe:1",
  ];
}

export class PysilkFfmpegTranscoder {
  readonly #pythonPath: string;
  readonly #ffmpegPath: string;
  readonly #sampleRate: number;
  readonly #timeoutMs: number;
  readonly #spawnImpl: SpawnProcess;
  readonly #onDiagnostics: (line: string) => void;

  public constructor(options: PysilkFfmpegTranscoderOptions = {}) {
    this.#pythonPath = options.pythonPath ?? process.env.PYTHON_PATH ?? "python";
    this.#ffmpegPath =
      options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
    this.#sampleRate = options.sampleRate ?? 24_000;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#spawnImpl =
      options.spawnImpl ?? ((command, args) => spawn(command, [...args]));
    this.#onDiagnostics = options.onDiagnostics ?? (() => undefined);
  }

  /** SILK 字节转码为 MP3 字节；失败抛 AudioTranscodeError（错误码见类型） */
  public transcodeToMp3(input: Buffer): Promise<Buffer> {
    let decoder: SpawnedProcess;
    try {
      decoder = this.#spawnImpl(this.#pythonPath, [
        "-c",
        DECODE_SCRIPT.replace("%d", String(this.#sampleRate)),
      ]);
    } catch {
      return Promise.reject(unavailable("decoder"));
    }

    let encoder: SpawnedProcess;
    try {
      encoder = this.#spawnImpl(this.#ffmpegPath, encodeArgs(this.#sampleRate));
    } catch {
      decoder.kill();
      return Promise.reject(unavailable("encoder"));
    }

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      let outputEnded = false;

      const finishError = (error: AudioTranscodeError): void => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        decoder.kill();
        encoder.kill();
        reject(error);
      };
      const finishOk = (output: Buffer): void => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve(output);
      };

      // ENOENT 以异步 error 事件出现（同步 throw 已在上方处理）
      wireStageErrors(decoder, "decoder", finishError);
      wireStageErrors(encoder, "encoder", finishError);

      // 完整 stderr 只进受控诊断回调（服务端日志），不进入 Error 消息
      forwardDiagnostics(decoder.stderr, this.#onDiagnostics);
      forwardDiagnostics(encoder.stderr, this.#onDiagnostics);

      const timer = setTimeout(() => {
        finishError(
          new AudioTranscodeError(
            "transcode_failed",
            "audio transcode timed out",
          ),
        );
      }, this.#timeoutMs);
      timer.unref();

      // 输入 → 解码 → 编码
      decoder.stdin.on("error", () => {
        /* 下游提前退出时的 EPIPE：最终以退出码判定 */
      });
      decoder.stdout.pipe(encoder.stdin);
      decoder.stdout.on("end", () => {
        encoder.stdin.end();
      });
      decoder.stdin.end(input);

      encoder.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      encoder.stdout.on("end", () => {
        outputEnded = true;
      });

      const evaluate = (): void => {
        if (settled) return;
        if (decoder.exitCode === null || encoder.exitCode === null) return;
        if (decoder.exitCode !== 0) {
          finishError(
            new AudioTranscodeError(
              "transcode_failed",
              `audio decode stage failed (exit ${String(decoder.exitCode)})`,
            ),
          );
          return;
        }
        if (encoder.exitCode !== 0) {
          finishError(
            new AudioTranscodeError(
              "transcode_failed",
              `audio encode stage failed (exit ${String(encoder.exitCode)})`,
            ),
          );
          return;
        }
        if (!outputEnded) return;
        const output = Buffer.concat(chunks);
        if (output.length === 0) {
          finishError(
            new AudioTranscodeError(
              "transcode_failed",
              "audio transcode produced no output",
            ),
          );
          return;
        }
        finishOk(output);
      };

      const poll = setInterval(evaluate, POLL_INTERVAL_MS);
      // 兜底清理：finish 路径已各自清场，这里仅防极端悬挂
      const stopPoll = setTimeout(() => {
        clearInterval(poll);
      }, this.#timeoutMs + 1_000);
      stopPoll.unref();
    });
  }
}

function unavailable(stage: string): AudioTranscodeError {
  return new AudioTranscodeError(
    "transcode_unavailable",
    `voice transcription toolchain unavailable (${stage} not installed); configure ffmpeg/pysilk or expect degraded handling`,
  );
}

/** 任一标准流出现 ENOENT error 即视为对应可执行文件缺失 */
function wireStageErrors(
  stage: SpawnedProcess,
  name: string,
  fail: (error: AudioTranscodeError) => void,
): void {
  const onError = (error: NodeJS.ErrnoException): void => {
    if (error.code === "ENOENT") fail(unavailable(name));
    else
      fail(
        new AudioTranscodeError(
          "transcode_failed",
          `audio ${name} stage crashed`,
        ),
      );
  };
  for (const stream of [stage.stdin, stage.stdout, stage.stderr]) {
    stream.on("error", onError);
  }
}

function forwardDiagnostics(
  stream: NodeJS.ReadableStream,
  sink: (line: string) => void,
): void {
  stream.setEncoding("utf8");
  stream.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) sink(line.trim());
    }
  });
}

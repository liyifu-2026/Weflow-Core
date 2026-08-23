import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  PysilkFfmpegTranscoder,
  type AudioTranscodeError,
  type SpawnProcess,
} from "../infrastructure/media/audio-transcoder.js";

const SILK_BYTES = Buffer.from([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c]);
const PCM_BYTES = Buffer.from([0x01, 0x00, 0x02, 0x00]);
const MP3_BYTES = Buffer.from([0xff, 0xfb, 0x90, 0x00]);

type FakeStage = {
  program: string;
  process: {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    killed: boolean;
    kill(): boolean;
  };
};

function fakeStage(program: string): FakeStage {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    program,
    process: {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      killed: false,
      kill: () => {
        return true;
      },
    },
  };
}

function collect(stream: PassThrough): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", reject);
  });
}

describe("PysilkFfmpegTranscoder", () => {
  it("pipes SILK through decode and encode stages and returns MP3 bytes", async () => {
    const commands: string[] = [];
    const argsRecord: string[][] = [];
    let decodeInput: Buffer | undefined;
    const spawnImpl = ((command: string, args: string[]) => {
      commands.push(command);
      argsRecord.push(args);
      const stage = fakeStage(command);
      if (commands.length === 1) {
        // 解码阶段：读入 SILK，吐出 PCM
        void collect(stage.process.stdin).then((input) => {
          decodeInput = input;
          stage.process.stdout.end(PCM_BYTES);
          stage.process.exitCode = 0;
        });
      } else {
        // 编码阶段：读入 PCM，吐出 MP3
        void collect(stage.process.stdin);
        stage.process.stdout.end(MP3_BYTES);
        stage.process.exitCode = 0;
      }
      return stage.process;
    }) as unknown as SpawnProcess;

    const transcoder = new PysilkFfmpegTranscoder({ spawnImpl });
    const result = await transcoder.transcodeToMp3(SILK_BYTES);

    expect(result.equals(MP3_BYTES)).toBe(true);
    expect(decodeInput?.equals(SILK_BYTES)).toBe(true);
    expect(commands[0]).toContain("python");
    expect(commands[1]).toContain("ffmpeg");
    expect(argsRecord[1]).toContain("-f");
    expect(argsRecord[1]).toContain("mp3");
  });

  it("maps a missing decoder or encoder binary to transcode_unavailable without exposing paths", async () => {
    const spawnImpl = (() => {
      throw Object.assign(new Error("spawn %SystemRoot%\\ffmpeg.exe ENOENT"), {
        code: "ENOENT",
      });
    }) as unknown as SpawnProcess;
    const transcoder = new PysilkFfmpegTranscoder({ spawnImpl });

    await expect(transcoder.transcodeToMp3(SILK_BYTES)).rejects.toMatchObject({
      name: "AudioTranscodeError",
      code: "transcode_unavailable",
    });
    await expect(transcoder.transcodeToMp3(SILK_BYTES)).rejects.toThrow(
      /transcription toolchain unavailable/,
    );
  });

  it("emits an async spawn error event as transcode_unavailable", async () => {
    const spawnImpl = (() => {
      const stage = fakeStage("python");
      queueMicrotask(() => {
        stage.process.stderr.emit(
          "error",
          Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
        );
      });
      return stage.process;
    }) as unknown as SpawnProcess;
    const transcoder = new PysilkFfmpegTranscoder({ spawnImpl });

    await expect(transcoder.transcodeToMp3(SILK_BYTES)).rejects.toMatchObject({
      code: "transcode_unavailable",
    });
  });

  it("maps a non-zero encoder exit to transcode_failed with sanitized message", async () => {
    const spawnImpl = ((command: string) => {
      const stage = fakeStage(command);
      if (command.includes("python")) {
        stage.process.stdout.end(PCM_BYTES);
        stage.process.exitCode = 0;
      } else {
        stage.process.stderr.write(
          "pipe:: Invalid data found C:\\Users\\12991\\tmp\\secret-input.silk",
        );
        stage.process.exitCode = 1;
      }
      return stage.process;
    }) as unknown as SpawnProcess;
    const diagnostics: string[] = [];
    const transcoder = new PysilkFfmpegTranscoder({
      spawnImpl,
      onDiagnostics: (line) => diagnostics.push(line),
    });

    const error = await transcoder.transcodeToMp3(SILK_BYTES).then(
      () => {
        throw new Error("expected rejection");
      },
      (caught: unknown) => caught as AudioTranscodeError,
    );
    expect(error.code).toBe("transcode_failed");
    expect(error.message).not.toContain("C:\\Users");
    expect(error.message).not.toContain("secret-input");
    // 完整诊断只走受控回调（服务端日志），不进入错误消息
    expect(diagnostics.join("\n")).toContain("Invalid data");
  });

  it("propagates empty output as transcode_failed", async () => {
    const spawnImpl = ((command: string) => {
      const stage = fakeStage(command);
      if (command.includes("python")) {
        stage.process.stdout.end(PCM_BYTES);
        stage.process.exitCode = 0;
      } else {
        stage.process.stdout.end();
        stage.process.exitCode = 0;
      }
      return stage.process;
    }) as unknown as SpawnProcess;
    const transcoder = new PysilkFfmpegTranscoder({ spawnImpl });

    await expect(transcoder.transcodeToMp3(SILK_BYTES)).rejects.toMatchObject({
      code: "transcode_failed",
    });
  });
});

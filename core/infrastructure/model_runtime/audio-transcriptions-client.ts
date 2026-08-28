/**
 * OpenAI 兼容语音转写客户端（audio/transcriptions）
 *
 * 标准 multipart/form-data 协议（OpenAI 兼容端点，如硅基流动）：
 *   POST {baseUrl}/audio/transcriptions
 *     file: <audio bytes>
 *     model: <asr model>
 *
 * 与 MimoAudioClient（chat/completions + input_audio 内联）并存：
 * 平台按 ASR 配置选择客户端——配置了专用 ASR 端点时用本客户端。
 */
import { z } from "zod";

const responseSchema = z.object({
  text: z.string(),
});

/** OpenAI 兼容 audio/transcriptions 客户端 */
export class AudioTranscriptionsClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
      fetch?: typeof globalThis.fetch;
    },
  ) {}

  /**
   * 转写一段语音（MP3/WAV/OGG/FLAC/M4A；SILK 须先转码）。
   * @returns 转写文本（一行以内，最多 2000 字符）
   */
  async transcribe(audio: Buffer, mimeType: string, fileName = "audio.mp3"): Promise<string> {
    const form = new FormData();
    const blob = new Blob([audio], { type: mimeType });
    form.append("file", blob, fileName);
    form.append("model", this.options.model);
    const response = await (this.options.fetch ?? globalThis.fetch)(
      `${this.options.baseUrl.replace(/\/$/, "")}/audio/transcriptions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `audio transcriptions API returned ${String(response.status)}: ${body.slice(0, 500)}`,
      );
    }
    const parsed = responseSchema.parse(await response.json());
    const transcription = (parsed.text ?? "").trim();
    if (!transcription) {
      throw new Error("audio transcriptions API returned an empty text");
    }
    return transcription.slice(0, 2_000);
  }
}

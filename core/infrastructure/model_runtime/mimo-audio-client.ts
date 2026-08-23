/**
 * MiMo 语音转写客户端
 * 封装与 MiMo（OpenAI 兼容端点）的语音理解交互：把音频以 input_audio
 * 内联进请求，返回一段中文转写文本。与视觉客户端共用同一端点与密钥。
 */
import { z } from "zod";

/** 响应 Schema 验证（兼容推理模型把结果写在 reasoning_content 的情况） */
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1),
});

/** MiMo 语音转写客户端类 */
export class MimoAudioClient {
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
   * 转写一段语音
   * @param audio - 音频 Buffer（MiMo 仅接受 mp3/flac/m4a/wav/ogg；
   * SILK 等原始编码须先经平台转码器转为 MP3 再调用本方法）
   * @param mimeType - 音频 MIME 类型（如 audio/mpeg、audio/wav）
   * @returns 语音的中文转写（一行以内）
   *
   * 注意：专用 ASR 模型（mimo-v2.5-asr）要求请求**不得包含 text parts**
   * （转写指令由网关注入），因此这里只内联 input_audio。
   */
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const response = await (this.options.fetch ?? globalThis.fetch)(
      `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          stream: false,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: {
                    data: `data:${mimeType};base64,${audio.toString("base64")}`,
                  },
                },
              ],
            },
          ],
          max_tokens: 256,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `audio API returned ${String(response.status)}: ${body.slice(0, 500)}`,
      );
    }
    const parsed = responseSchema.parse(await response.json());
    const message = parsed.choices[0]?.message;
    const transcription = (
      message?.content ??
      message?.reasoning_content ??
      ""
    ).trim();
    if (!transcription) {
      throw new Error("audio API returned an empty transcription");
    }
    return transcription.slice(0, 2_000);
  }
}

/**
 * MiMo 视觉模型客户端
 * 封装与 MiMo v2.5 视觉模型的交互，用于图片内容描述
 * 将图片转为 base64 发送，返回简洁的中文描述
 */
import { z } from "zod";

/** 响应 Schema 验证 */
const responseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
});

/** MiMo 视觉模型客户端类 */
export class MimoVisionClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: "mimo-v2.5";
      timeoutMs: number;
      fetch?: typeof globalThis.fetch;
    },
  ) {}

  /**
   * 描述图片内容
   * @param image - 图片 Buffer
   * @param mimeType - 图片 MIME 类型
   * @returns 图片的中文描述（最多8000字符）
   */
  async describe(
    image: Buffer,
    mimeType: string,
    model?: string,
  ): Promise<string> {
    const response = await (this.options.fetch ?? globalThis.fetch)(
      `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: model ?? this.options.model,
          stream: false,
          messages: [
            {
              role: "system",
              content:
                "请客观描述这张图片中的重要内容和可见文字。不要猜测不可见信息。用简洁中文输出，供后续对话模型理解。",
            },
            {
              role: "user",
              content: [
                { type: "text", text: "描述这张图片。" },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType};base64,${image.toString("base64")}`,
                  },
                },
              ],
            },
          ],
          max_tokens: 800,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `vision API returned ${String(response.status)}: ${body.slice(0, 500)}`,
      );
    }
    const parsed = responseSchema.parse(await response.json());
    const description = parsed.choices[0]?.message.content.trim();
    if (!description) throw new Error("vision API returned an empty response");
    return description.slice(0, 8_000);
  }
}

import { describe, expect, it, vi } from "vitest";
import { MimoVisionClient } from "../infrastructure/model_runtime/mimo-vision-client.js";

describe("MimoVisionClient", () => {
  it("sends a private image as an ephemeral data URL to mimo-v2.5", async () => {
    let requestBody: unknown;
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      requestBody =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return Promise.resolve(
        Response.json({
          choices: [{ message: { content: "图片里是一只猫。" } }],
        }),
      );
    });
    const client = new MimoVisionClient({
      baseUrl: "https://mimo.example/v1/",
      apiKey: "temporary-test-key",
      model: "mimo-v2.5",
      timeoutMs: 1_000,
      fetch,
    });

    await expect(
      client.describe(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"),
    ).resolves.toBe("图片里是一只猫。");
    expect(requestBody).toMatchObject({
      model: "mimo-v2.5",
      messages: [
        expect.any(Object),
        {
          role: "user",
          content: [
            expect.any(Object),
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,/9j/" },
            },
          ],
        },
      ],
    });
  });
});

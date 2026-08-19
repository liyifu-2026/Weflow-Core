import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";

describe("OpenAI-compatible model client", () => {
  it("uses bearer auth without exposing the key in the request body", async () => {
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({
          authorization: "Bearer temporary-secret",
          "content-type": "application/json",
        });
        expect(init?.body).not.toContain("temporary-secret");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: " response " } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    );
    const client = new OpenAiCompatibleClient({
      baseUrl: "https://api.deepseek.com",
      apiKey: "temporary-secret",
      model: "deepseek-v4-flash",
      timeoutMs: 1_000,
      fetch,
    });

    await expect(
      client.complete([{ role: "user", content: "hello" }]),
    ).resolves.toBe("response");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries one transient empty response", async () => {
    let firstBody: unknown;
    let calls = 0;
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) firstBody = init?.body;
        return Promise.resolve(
          calls === 1
            ? Response.json({ choices: [{ message: { content: "" } }] })
            : Response.json({
                choices: [{ message: { content: '{"ok":true}' } }],
              }),
        );
      },
    );
    const client = new OpenAiCompatibleClient({
      baseUrl: "https://api.deepseek.com",
      apiKey: "temporary-secret",
      model: "deepseek-v4-flash",
      timeoutMs: 1_000,
      fetch,
    });
    await expect(
      client.complete([{ role: "user", content: "hello" }], {
        jsonObject: true,
      }),
    ).resolves.toBe('{"ok":true}');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(firstBody))).toMatchObject({
      response_format: { type: "json_object" },
    });
  });
});

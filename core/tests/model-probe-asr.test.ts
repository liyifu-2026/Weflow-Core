/**
 * ASR 模型「测试连接」探测分流（0073 协议字段配套）：
 * - audio_transcriptions 协议 → multipart /audio/transcriptions 音频探测
 * - chat_inline 协议的 asr 模型 → chat/completions input_audio 内联探测
 * - 纯文本模型保持 chat 补全 ping 探针不变
 * - HTTP 2xx 即成功（空转写文本不算失败）；非 2xx 报出原始错误
 */
import { describe, expect, it } from "vitest";
import { probeModelConnection } from "../modules/operations/application/model-failover.js";

const WAV_BASE64 =
  "UklGRgAAAABXQVZFZm10IBAAAAABAAEAQBAAAAEAIAACAAACABAATGV0dGVyIFcgAAA=";

function fakeFetch(
  statusByPath: Record<string, { status: number; body: string }>,
  captured: { url?: string; body?: unknown; contentType?: string } = {},
) {
  return (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    captured.url = String(url);
    captured.contentType =
      (init?.headers as Record<string, string> | undefined)?.["content-type"] ??
      "multipart/form-data";
    if (captured.contentType.startsWith("application/json")) {
      captured.body = JSON.parse(String(init?.body));
    }
    const hit =
      Object.entries(statusByPath).find(([key]) => path.endsWith(key))?.[1] ??
      { status: 404, body: "not found" };
    return new Response(hit.body, { status: hit.status });
  }) as unknown as typeof globalThis.fetch;
}

describe("probeModelConnection ASR 分流", () => {
  it("audio_transcriptions 协议探测 multipart 端点（200 = 成功）", async () => {
    const captured: { url?: string; contentType?: string } = {};
    const fetchMock = fakeFetch(
      { "/audio/transcriptions": { status: 200, body: '{"text":""}' } },
      captured,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const result = await probeModelConnection(
        {
          baseUrl: "https://api.siliconflow.cn/v1",
          apiKey: "sk-test",
          displayName: "XingChenAGI/XingChenASR-V3.2-Ultra",
          capabilities: ["asr"],
          protocol: "audio_transcriptions",
        },
        5_000,
      );
      expect(result).toMatchObject({ ok: true });
      expect(captured.url).toBe(
        "https://api.siliconflow.cn/v1/audio/transcriptions",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("chat_inline 协议的 asr 模型探测 input_audio 内联端点", async () => {
    const captured: { url?: string; body?: unknown } = {};
    const fetchMock = fakeFetch(
      { "/chat/completions": { status: 200, body: '{"choices":[]}' } },
      captured,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const result = await probeModelConnection(
        {
          baseUrl: "https://api.xiaomimimo.com/v1",
          apiKey: "sk-test",
          displayName: "mimo-v2.5-asr",
          capabilities: ["asr"],
          protocol: "chat_inline",
        },
        5_000,
      );
      expect(result).toMatchObject({ ok: true });
      expect(captured.url).toBe(
        "https://api.xiaomimimo.com/v1/chat/completions",
      );
      const body = captured.body as {
        messages: { content: { type: string }[] }[];
      };
      expect(body.messages[0]?.content?.[0]?.type).toBe("input_audio");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("端点拒收（如模型不存在）→ ok:false 带原始错误", async () => {
    const fetchMock = fakeFetch({
      "/audio/transcriptions": {
        status: 400,
        body: '{"code":20012,"message":"Model does not exist"}',
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const result = await probeModelConnection(
        {
          baseUrl: "https://api.siliconflow.cn/v1",
          apiKey: "sk-test",
          displayName: "wrong-model",
          capabilities: ["asr"],
          protocol: "audio_transcriptions",
        },
        5_000,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Model does not exist");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("无 asr 能力的模型仍走 chat 补全 ping 探针", async () => {
    const captured: { url?: string } = {};
    const fetchMock = fakeFetch(
      {
        "/chat/completions": {
          status: 200,
          body: '{"choices":[{"message":{"content":"pong"}}]}',
        },
      },
      captured,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const result = await probeModelConnection(
        {
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-test",
          displayName: "deepseek-v4-flash",
          capabilities: ["text"],
          protocol: "chat_inline",
        },
        5_000,
      );
      expect(result).toMatchObject({ ok: true });
      expect(captured.url).toBe("https://api.deepseek.com/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// 保持 WAV 常量被引用（未来若删探测用例不至悬空）
void WAV_BASE64;

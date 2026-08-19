import { describe, expect, it, vi } from "vitest";
import { TextModelError } from "../modules/model/contracts/text-model-error.js";
import {
  extractMemories,
  memoryIdFor,
  memoryCaptureErrorCode,
  parseMemoryExtraction,
  publishedStatus,
} from "../modules/memory/application/memory-extraction.js";

describe("memory extraction contract", () => {
  it("parses fenced structured output and classifies safe facts", () => {
    const [memory] = parseMemoryExtraction(`\`\`\`json
{"memories":[{"kind":"preference","key":"preferred_name","content":"Leaif","confidence":96,"evidenceMessageIds":["message-1"],"subject":"contact","explicit":true,"stable":true,"sensitive":false}]}
\`\`\``);
    expect(memory).toBeDefined();
    if (!memory) throw new Error("expected extracted memory");
    expect(publishedStatus(memory)).toBe("active");
  });

  it("keeps sensitive or uncertain information as candidates", () => {
    expect(
      publishedStatus({
        kind: "fact",
        key: "health",
        content: "sensitive",
        confidence: 99,
        evidenceMessageIds: ["message-1"],
        subject: "contact",
        explicit: true,
        stable: true,
        sensitive: true,
      }),
    ).toBe("candidate");
    expect(
      publishedStatus({
        kind: "fact",
        key: "health_diagnosis",
        content: "模型错误地标记为非敏感",
        confidence: 99,
        evidenceMessageIds: ["message-1"],
        subject: "contact",
        explicit: true,
        stable: true,
        sensitive: false,
      }),
    ).toBe("candidate");
  });

  it("creates stable content-addressed ids", () => {
    expect(memoryIdFor("c", "fact", "city", "杭州")).toBe(
      memoryIdFor("c", "fact", "city", "杭州"),
    );
    expect(memoryIdFor("c", "fact", "city", "上海")).not.toBe(
      memoryIdFor("c", "fact", "city", "杭州"),
    );
  });

  it("extracts memories through the TextModel structured-output capability", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: '{"memories":[]}',
      modelId: "memory-model",
    });

    await expect(
      extractMemories({ generate }, [
        {
          messageId: "message-1",
          direction: "inbound",
          actorType: "channel_contact",
          text: "hello",
        },
      ]),
    ).resolves.toEqual([]);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ output: "structured" }),
    );
  });

  it("preserves extraction parsing errors and provider failures", async () => {
    const messages = [
      {
        messageId: "message-1",
        direction: "inbound",
        actorType: "channel_contact",
        text: "hello",
      },
    ];
    await expect(
      extractMemories(
        {
          generate: vi
            .fn()
            .mockResolvedValue({ text: "{invalid}", modelId: "m" }),
        },
        messages,
      ),
    ).rejects.toThrow(SyntaxError);
    await expect(
      extractMemories(
        {
          generate: vi
            .fn()
            .mockResolvedValue({ text: '{"memories":[{}]}', modelId: "m" }),
        },
        messages,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      extractMemories(
        {
          generate: vi
            .fn()
            .mockRejectedValue(
              new Error("model API returned an empty response"),
            ),
        },
        messages,
      ),
    ).rejects.toThrow("model API returned an empty response");
    await expect(
      extractMemories(
        {
          generate: vi
            .fn()
            .mockRejectedValue(new TextModelError("timeout", "timed out")),
        },
        messages,
      ),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      extractMemories(
        {
          generate: vi
            .fn()
            .mockRejectedValue(new TextModelError("unavailable", "offline")),
        },
        messages,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("maps provider failures to the existing memory capture error semantics", () => {
    expect(
      memoryCaptureErrorCode(new TextModelError("timeout", "timed out")),
    ).toBe("model_timeout");
    expect(
      memoryCaptureErrorCode(new TextModelError("unavailable", "offline")),
    ).toBe("memory_capture_failed");
    expect(
      memoryCaptureErrorCode(new Error("model API returned an empty response")),
    ).toBe("memory_capture_failed");
    expect(memoryCaptureErrorCode(new SyntaxError("bad json"))).toBe(
      "invalid_model_json",
    );
  });
});

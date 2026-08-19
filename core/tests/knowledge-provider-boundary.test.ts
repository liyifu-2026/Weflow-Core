import { describe, expect, it, vi } from "vitest";
import {
  inspectKnowledgeEngine,
  isAllowedKnowledgeProviderMethod,
  isAllowedKnowledgeProviderPath,
  knowledgeProviderAccess,
  MAX_KNOWLEDGE_UPLOAD_BYTES,
  providerPath,
} from "../modules/knowledge-provider/application/boundary.js";

describe("Console knowledge boundary", () => {
  it("allows only the explicit migration surface", () => {
    expect(
      isAllowedKnowledgeProviderPath("knowledge-bases/kb-1/faq/entries"),
    ).toBe(true);
    expect(
      isAllowedKnowledgeProviderPath("knowledgebase/kb-1/wiki/pages"),
    ).toBe(true);
    expect(isAllowedKnowledgeProviderPath("datasource/source-1/logs")).toBe(
      true,
    );
    expect(isAllowedKnowledgeProviderPath("chunker/preview")).toBe(true);
    expect(isAllowedKnowledgeProviderPath("models/model-1/debug")).toBe(true);
    expect(isAllowedKnowledgeProviderPath("vector-stores/store-1/test")).toBe(
      true,
    );
    expect(
      isAllowedKnowledgeProviderPath("storage-backends/backend-1/test"),
    ).toBe(true);
    expect(isAllowedKnowledgeProviderPath("agents")).toBe(false);
    expect(isAllowedKnowledgeProviderPath("sessions/session-1")).toBe(false);
  });

  it("rejects decoded and double-encoded traversal", () => {
    const request = (url: string) =>
      ({ raw: { url } }) as Parameters<typeof providerPath>[0];
    expect(
      providerPath(
        request("/api/v1/console/knowledge-provider/knowledge/../models"),
      ),
    ).toBeUndefined();
    expect(
      providerPath(
        request("/api/v1/console/knowledge-provider/knowledge/%2e%2e/models"),
      ),
    ).toBeUndefined();
    expect(
      providerPath(
        request(
          "/api/v1/console/knowledge-provider/knowledge/%252e%252e/models",
        ),
      ),
    ).toBeUndefined();
    expect(
      providerPath(
        request("/api/v1/console/knowledge-provider/knowledge-bases"),
      ),
    ).toBe("knowledge-bases");
  });

  it("allows only explicit HTTP methods and maps the role matrix", () => {
    expect(isAllowedKnowledgeProviderMethod("knowledge-bases", "GET")).toBe(
      true,
    );
    expect(isAllowedKnowledgeProviderMethod("knowledge-bases", "TRACE")).toBe(
      false,
    );
    expect(isAllowedKnowledgeProviderMethod("knowledge-search", "POST")).toBe(
      true,
    );
    expect(isAllowedKnowledgeProviderMethod("knowledge-search", "DELETE")).toBe(
      false,
    );
    expect(isAllowedKnowledgeProviderMethod("chunker/preview", "GET")).toBe(
      false,
    );
    expect(knowledgeProviderAccess("knowledge-bases", "GET")).toBe("read");
    expect(knowledgeProviderAccess("knowledge-search", "POST")).toBe("read");
    expect(knowledgeProviderAccess("knowledge-bases", "POST")).toBe("write");
    expect(MAX_KNOWLEDGE_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });

  it("returns a redacted health summary", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(
        new Error("postgres://admin:secret@internal/provider"),
      );
    const result = await inspectKnowledgeEngine({
      baseUrl: "http://knowledge.internal/api/v1",
      apiKey: "super-secret",
      timeoutMs: 1_000,
      fetch,
    });
    expect(result.status).toBe("degraded");
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("postgres://");
    expect(result.components[0]?.summary).toBe("服务当前不可访问");
  });
});

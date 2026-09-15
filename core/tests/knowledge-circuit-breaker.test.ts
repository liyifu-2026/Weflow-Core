import { describe, expect, it, vi } from "vitest";
import {
  createCircuitBreakerKnowledgeSearch,
  KNOWLEDGE_CIRCUIT_OPEN_ERROR,
} from "../infrastructure/knowledge/knowledge-circuit-breaker.js";

function failingSearch(message = "weknora_request_failed:500") {
  return {
    search: vi.fn().mockRejectedValue(new Error(message)),
  };
}

const query = { query: "错误码 12535" };

describe("knowledge circuit breaker", () => {
  it("stays closed below the failure threshold", async () => {
    const breaker = createCircuitBreakerKnowledgeSearch(failingSearch());
    await expect(breaker.search(query)).rejects.toThrow();
    await expect(breaker.search(query)).rejects.toThrow();
    expect(breaker.isOpen()).toBe(false);
  });

  it("opens after 3 consecutive failures and fast-fails without calling inner", async () => {
    const inner = failingSearch();
    const breaker = createCircuitBreakerKnowledgeSearch(inner);
    await expect(breaker.search(query)).rejects.toThrow(
      "weknora_request_failed",
    );
    await expect(breaker.search(query)).rejects.toThrow(
      "weknora_request_failed",
    );
    await expect(breaker.search(query)).rejects.toThrow(
      "weknora_request_failed",
    );
    expect(breaker.isOpen()).toBe(true);

    // open 态：不再触达底层客户端，直接快速失败
    const innerCalls = inner.search.mock.calls.length;
    await expect(breaker.search(query)).rejects.toThrow(
      KNOWLEDGE_CIRCUIT_OPEN_ERROR,
    );
    expect(inner.search.mock.calls.length).toBe(innerCalls);
  });

  it("resets the failure counter on success", async () => {
    let fail = true;
    const inner = {
      search: vi
        .fn()
        .mockImplementation(() =>
          fail ? Promise.reject(new Error("boom")) : Promise.resolve([]),
        ),
    };
    const breaker = createCircuitBreakerKnowledgeSearch(inner);
    await expect(breaker.search(query)).rejects.toThrow();
    await expect(breaker.search(query)).rejects.toThrow();
    fail = false;
    await expect(breaker.search(query)).resolves.toEqual([]);
    fail = true;
    // 计数已清零：两次失败不应打开熔断
    await expect(breaker.search(query)).rejects.toThrow("boom");
    await expect(breaker.search(query)).rejects.toThrow("boom");
    expect(breaker.isOpen()).toBe(false);
  });

  it("half-open probe after cooldown closes on success", async () => {
    let fail = true;
    const inner = {
      search: vi
        .fn()
        .mockImplementation(() =>
          fail ? Promise.reject(new Error("boom")) : Promise.resolve(["ev"]),
        ),
    };
    const breaker = createCircuitBreakerKnowledgeSearch(inner);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.search(query)).rejects.toThrow();
    }
    expect(breaker.isOpen()).toBe(true);

    // 冷却期满：half-open 放行一次探测
    fail = false;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    try {
      await expect(breaker.search(query)).resolves.toEqual(["ev"]);
      expect(breaker.isOpen()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("half-open probe failure re-opens the cooldown window", async () => {
    const inner = failingSearch("weknora_invalid_response");
    const breaker = createCircuitBreakerKnowledgeSearch(inner);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.search(query)).rejects.toThrow();
    }

    vi.useFakeTimers();
    try {
      // 冷却期满的探测仍失败：重新计时，继续 fast-fail
      vi.setSystemTime(Date.now() + 61_000);
      await expect(breaker.search(query)).rejects.toThrow(
        "weknora_invalid_response",
      );
      expect(breaker.isOpen()).toBe(true);
      vi.setSystemTime(Date.now() + 30_000);
      await expect(breaker.search(query)).rejects.toThrow(
        KNOWLEDGE_CIRCUIT_OPEN_ERROR,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

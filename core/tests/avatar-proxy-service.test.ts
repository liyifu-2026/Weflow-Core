/**
 * 头像代理服务单元测试
 * 验证：域名白名单、缓存命中与 TTL 过期、上限淘汰、
 * 上游 404/5xx/网络错误的状态映射。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AvatarProxyService,
  isAllowedAvatarUrl,
} from "../modules/contacts/application/avatar-proxy-service.js";

const ALLOWED_HOSTS = ["example-cdn.com"] as const;

describe("isAllowedAvatarUrl", () => {
  it("allows whitelisted CDN hosts（含子域名）", () => {
    expect(
      isAllowedAvatarUrl(
        "http://example-cdn.com/mmopen/abc/132",
        ALLOWED_HOSTS,
      ),
    ).toBe(true);
    expect(
      isAllowedAvatarUrl(
        "https://img.example-cdn.com/mmopen/abc/0",
        ALLOWED_HOSTS,
      ),
    ).toBe(true);
    expect(
      isAllowedAvatarUrl("https://cdn.example-cdn.com/x", ALLOWED_HOSTS),
    ).toBe(true);
    expect(isAllowedAvatarUrl("http://example-cdn.com/y", ALLOWED_HOSTS)).toBe(
      true,
    );
  });

  it("rejects foreign hosts and malformed URLs", () => {
    expect(isAllowedAvatarUrl("https://evil.com/a.jpg", ALLOWED_HOSTS)).toBe(
      false,
    );
    expect(
      isAllowedAvatarUrl(
        "https://example-cdn.com.evil.com/a.jpg",
        ALLOWED_HOSTS,
      ),
    ).toBe(false);
    expect(isAllowedAvatarUrl("not a url", ALLOWED_HOSTS)).toBe(false);
    expect(isAllowedAvatarUrl("", ALLOWED_HOSTS)).toBe(false);
  });

  it("rejects everything when the allow-list is empty", () => {
    expect(isAllowedAvatarUrl("https://example-cdn.com/a.jpg", [])).toBe(false);
  });
});

describe("AvatarProxyService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const avatarUrl = "http://example-cdn.com/a.jpg";

  it("fetches once and serves subsequent calls from cache", async () => {
    // 每次调用返回新的 Response 实例（body 只能消费一次）
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      ),
    );
    const service = new AvatarProxyService({ fetch });
    const first = await service.fetch(avatarUrl);
    const second = await service.fetch(avatarUrl);
    expect(first.state).toBe("ready");
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("validates URLs against its own allow-list", () => {
    const service = new AvatarProxyService({
      allowedHosts: ["example-cdn.com"],
    });
    expect(service.isAllowedAvatarUrl(avatarUrl)).toBe(true);
    expect(service.isAllowedAvatarUrl("https://evil.com/a.jpg")).toBe(false);
  });

  it("refetches after TTL expiry", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(new Uint8Array([1]), { status: 200 })),
      );
    const service = new AvatarProxyService({ fetch, cacheTtlMs: 60_000 });
    await service.fetch(avatarUrl);
    vi.setSystemTime(Date.now() + 60_001);
    await service.fetch(avatarUrl);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maps upstream 404 to not_found without caching", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    const service = new AvatarProxyService({ fetch });
    await expect(service.fetch(`${avatarUrl}/gone.jpg`)).resolves.toEqual({
      state: "not_found",
    });
    await expect(service.fetch(`${avatarUrl}/gone.jpg`)).resolves.toEqual({
      state: "not_found",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maps upstream 5xx and network errors to failed", async () => {
    const fetch500 = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 500 }));
    const service500 = new AvatarProxyService({ fetch: fetch500 });
    await expect(service500.fetch(avatarUrl)).resolves.toEqual({
      state: "failed",
    });

    const fetchError = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("ECONNREFUSED"));
    const serviceError = new AvatarProxyService({ fetch: fetchError });
    await expect(serviceError.fetch(avatarUrl)).resolves.toEqual({
      state: "failed",
    });
  });

  it("evicts the oldest entry when the cache is full", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(new Uint8Array([1]), { status: 200 })),
      );
    const service = new AvatarProxyService({ fetch, maxEntries: 2 });
    await service.fetch(`${avatarUrl}/a.jpg`);
    await service.fetch(`${avatarUrl}/b.jpg`);
    await service.fetch(`${avatarUrl}/c.jpg`);
    // a 已被淘汰，再次请求应重新拉取
    await service.fetch(`${avatarUrl}/a.jpg`);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

/**
 * DiceBear 头像代理模块单元测试（不联网：注入 fetch 桩）。
 * 覆盖：白名单校验、URL 构造、缓存命中、上游失败返回 null。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDiceBearCache,
  diceBearAvatarUrl,
  DICEBEAR_STYLES,
  fetchDiceBearSvg,
  isDiceBearStyle,
} from "../modules/identity/application/dicebear-avatars.js";
import {
  defaultUserAvatarPreset,
  fallbackPresetSvg,
  USER_AVATAR_PRESETS,
  userAvatarPresetUrl,
} from "../modules/identity/application/avatar-presets.js";

afterEach(() => clearDiceBearCache());

describe("dicebear avatars", () => {
  it("restricts styles to the allowlist", () => {
    expect(isDiceBearStyle("blobs")).toBe(true);
    expect(isDiceBearStyle("voxel-bot")).toBe(true);
    expect(isDiceBearStyle("notionists")).toBe(false);
    expect(DICEBEAR_STYLES).toHaveLength(2);
  });

  it("builds platform proxy urls for styles and seeds", () => {
    expect(diceBearAvatarUrl("blobs", "waaun9hx")).toBe(
      "/api/v1/avatars/dicebear/blobs/waaun9hx",
    );
    expect(diceBearAvatarUrl("voxel-bot", "ai_employee:x y")).toBe(
      `/api/v1/avatars/dicebear/voxel-bot/${encodeURIComponent("ai_employee:x y")}`,
    );
  });

  it("fetches svg once and serves repeats from cache", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return new Response("<svg xmlns='x'></svg>", { status: 200 });
    }) as unknown as typeof fetch;
    const first = await fetchDiceBearSvg("blobs", "seed-a", fetchMock);
    const second = await fetchDiceBearSvg("blobs", "seed-a", fetchMock);
    expect(first).toContain("<svg");
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("returns null on upstream failure without caching", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    expect(await fetchDiceBearSvg("blobs", "seed-b", fetchMock)).toBeNull();
    expect(await fetchDiceBearSvg("blobs", "seed-b", fetchMock)).toBeNull();
    expect(calls).toBe(2);
  });

  it("rejects non-svg upstream bodies", async () => {
    const fetchMock = (async () =>
      new Response("<html>nope</html>", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchDiceBearSvg("voxel-bot", "seed-c", fetchMock)).toBeNull();
  });

  it("maps user presets to proxy urls and local fallback svg", () => {
    expect(USER_AVATAR_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const preset of USER_AVATAR_PRESETS) {
      expect(userAvatarPresetUrl(preset)).toBe(
        `/api/v1/avatars/dicebear/blobs/${preset.seed}`,
      );
      expect(fallbackPresetSvg(preset)).toContain("<svg");
    }
    // 默认分配保持确定性：同一 seed 永远同一预设
    expect(defaultUserAvatarPreset("alice").id).toBe(
      defaultUserAvatarPreset("alice").id,
    );
  });
});

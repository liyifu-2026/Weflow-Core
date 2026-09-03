/**
 * 平台模型设置热加载单元测试�? *
 * 覆盖�? * - startModelSettingsReloader：同进程写路径通知 �?立即重读�?apply�? * - 内容未变化时不重�?apply�? * - 读失败保持旧快照、下个周期重试；
 * - HotReloadableClient：swap 后新请求走新端点，飞行中请求不中断�? */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HotReloadableClient } from "../infrastructure/model_runtime/hot-reloadable-client.js";
import { OpenAiCompatibleClient } from "../infrastructure/model_runtime/openai-compatible-client.js";
import {
  notifyModelSettingsChanged,
  startModelSettingsReloader,
} from "../modules/operations/application/model-settings-hot.js";
import type { ModelSettingsRuntime } from "../modules/operations/application/model-settings.js";

const defaults = {
  textModel: {
    name: "deepseek-v4-flash",
    baseUrl: "https://env.test",
    apiKey: "env-key",
  },
  visionModel: { name: "mimo-v2.5", baseUrl: "https://env.test" },
  asrModel: { name: "mimo-v2.5", baseUrl: "https://env.test" },
};

const seed: ModelSettingsRuntime = {
  textModel: {
    name: "deepseek-v4-flash",
    baseUrl: "https://db.test",
    apiKey: "db-key",
  },
  visionModel: {
    name: "mimo-v2.5",
    baseUrl: "https://db.test",
    apiKey: "db-key",
  },
  asrModel: { name: "mimo-v2.5", baseUrl: "https://db.test", apiKey: "db-key" },
};

const changed: ModelSettingsRuntime = {
  ...seed,
  textModel: {
    name: "deepseek-v4-pro",
    baseUrl: "https://new.test",
    apiKey: "new-key",
  },
};

function makeDb(): never {
  return {} as never;
}

describe("model settings hot reload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies a changed snapshot when the write path notifies subscribers", async () => {
    vi.useFakeTimers();
    let next = seed;
    vi.spyOn(
      await import("../modules/operations/application/model-settings.js"),
      "readModelSettingsRuntime",
    ).mockImplementation(() => Promise.resolve(next));
    const apply = vi.fn();
    const stop = startModelSettingsReloader(
      makeDb(),
      defaults,
      seed,
      apply,
      3_600_000,
    );
    expect(apply).not.toHaveBeenCalled();

    next = changed;
    notifyModelSettingsChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(changed);
    stop();
    vi.useRealTimers();
  });

  it("does not re-apply when the reread snapshot is identical", async () => {
    vi.useFakeTimers();
    vi.spyOn(
      await import("../modules/operations/application/model-settings.js"),
      "readModelSettingsRuntime",
    ).mockImplementation(() => Promise.resolve(seed));
    const apply = vi.fn();
    const stop = startModelSettingsReloader(
      makeDb(),
      defaults,
      seed,
      apply,
      3_600_000,
    );
    notifyModelSettingsChanged();
    notifyModelSettingsChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).not.toHaveBeenCalled();
    stop();
    vi.useRealTimers();
  });

  it("keeps the previous snapshot when a reread fails, then converges", async () => {
    vi.useFakeTimers();
    let fail = true;
    vi.spyOn(
      await import("../modules/operations/application/model-settings.js"),
      "readModelSettingsRuntime",
    ).mockImplementation(() =>
      fail ? Promise.reject(new Error("db down")) : Promise.resolve(changed),
    );
    const apply = vi.fn();
    const stop = startModelSettingsReloader(
      makeDb(),
      defaults,
      seed,
      apply,
      3_600_000,
    );
    notifyModelSettingsChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).not.toHaveBeenCalled();

    fail = false;
    notifyModelSettingsChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(changed);
    stop();
    vi.useRealTimers();
  });

  it("routes requests to the swapped client without touching in-flight ones", async () => {
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { model: string };
        return Promise.resolve(
          Response.json({
            choices: [{ message: { content: "ok" } }],
            model: body.model,
          }),
        );
      },
    );
    const initial = new OpenAiCompatibleClient({
      baseUrl: "https://old.test",
      apiKey: "old-key",
      model: "old-model",
      timeoutMs: 1_000,
      fetch,
    });
    const hot = new HotReloadableClient(initial);
    const inFlight = hot.generate({
      messages: [{ role: "user", content: "hi" }],
      output: "text",
    });

    hot.swap(
      new OpenAiCompatibleClient({
        baseUrl: "https://new.test",
        apiKey: "new-key",
        model: "new-model",
        timeoutMs: 1_000,
        fetch,
      }),
    );
    const afterSwap = await hot.generate({
      messages: [{ role: "user", content: "hi" }],
      output: "text",
    });
    expect(afterSwap.modelId).toBe("new-model");

    const beforeSwap = await inFlight;
    expect(beforeSwap.modelId).toBe("old-model");
    expect(hot.current).not.toBe(initial);
  });
});

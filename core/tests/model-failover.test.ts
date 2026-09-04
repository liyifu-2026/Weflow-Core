/**
 * 模型网关故障转移（R2）单元测试：
 * - 主模型成功不触备用
 * - 主模型失败按链切换到备用
 * - 全链失败抛最后错误
 * - 健康状态记录成功/失败与原因
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  FailoverTextModel,
  readModelHealth,
  resetModelHealth,
  type FailoverLink,
} from "../modules/operations/application/model-failover.js";
import type { TextGenerationRequest } from "../modules/model/contracts/text-generation-request.js";
import type { TextGenerationResult } from "../modules/model/contracts/text-generation-result.js";
import type { TextModel } from "../modules/model/contracts/text-model.js";

const request: TextGenerationRequest = {
  messages: [{ role: "user", content: "ping" }],
};

function fakeLink(
  modelId: string,
  behavior: "ok" | "fail",
  text = "pong",
): FailoverLink {
  const client: TextModel = {
    async generate() {
      if (behavior === "fail") throw new Error(`${modelId} unavailable`);
      return { text } as TextGenerationResult;
    },
  };
  return { modelId, displayName: modelId, client };
}

afterEach(() => resetModelHealth());

describe("FailoverTextModel", () => {
  it("主模型成功时备用不被调用", async () => {
    let backupCalled = false;
    const primary = fakeLink("primary", "ok");
    const backupClient: TextModel = {
      async generate() {
        backupCalled = true;
        return { text: "backup" } as TextGenerationResult;
      },
    };
    const model = new FailoverTextModel([
      primary,
      { modelId: "backup", displayName: "backup", client: backupClient },
    ]);
    const result = await model.generate(request);
    expect(result.text).toBe("pong");
    expect(backupCalled).toBe(false);
  });

  it("主模型失败/超时自动切备用", async () => {
    const model = new FailoverTextModel([
      fakeLink("primary", "fail"),
      fakeLink("backup", "ok", "backup-reply"),
    ]);
    const result = await model.generate(request);
    expect(result.text).toBe("backup-reply");
  });

  it("全链失败抛最后一次错误", async () => {
    const model = new FailoverTextModel([
      fakeLink("a", "fail"),
      fakeLink("b", "fail"),
    ]);
    await expect(model.generate(request)).rejects.toThrow("b unavailable");
  });

  it("健康状态记录成功/失败与原因", async () => {
    const model = new FailoverTextModel([
      fakeLink("primary", "fail"),
      fakeLink("backup", "ok"),
    ]);
    await model.generate(request);
    const health = readModelHealth();
    const primary = health.find((h) => h.modelId === "primary");
    const backup = health.find((h) => h.modelId === "backup");
    expect(primary?.lastSuccess).toBe(false);
    expect(primary?.lastFailureReason).toBe("primary unavailable");
    expect(primary?.failureCount).toBe(1);
    expect(backup?.lastSuccess).toBe(true);
    expect(backup?.successCount).toBe(1);
  });

  it("空链构造直接抛错", () => {
    expect(() => new FailoverTextModel([])).toThrow("failover_chain_empty");
  });
});

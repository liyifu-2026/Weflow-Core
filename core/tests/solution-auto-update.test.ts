import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readAutoUpdateConfig,
  runSolutionAutoUpdateOnce,
} from "../infrastructure/solutions/solution-auto-update.js";

describe("solution-auto-update", () => {
  it("readAutoUpdateConfig 返回禁用当文件缺失", async () => {
    const config = await readAutoUpdateConfig(
      join(tmpdir(), `missing-${Date.now()}`, "config.json"),
    );
    expect(config.enabled).toBe(false);
  });

  it("readAutoUpdateConfig 解析 enabled/strategy/registry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weflow-auto-update-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(
        path,
        JSON.stringify({
          update: { enabled: true, strategy: "minor" },
          registry: { url: "http://reg.test", token: "t0k" },
        }),
      );
      const config = await readAutoUpdateConfig(path);
      expect(config.enabled).toBe(true);
      expect(config.strategy).toBe("minor");
      expect(config.registryUrl).toBe("http://reg.test");
      expect(config.token).toBe("t0k");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("禁用时 runSolutionAutoUpdateOnce 不执行任何升级", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weflow-auto-update-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ update: { enabled: false } }));
      const handled = await runSolutionAutoUpdateOnce({ configPath: path });
      expect(handled).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

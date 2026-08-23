import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadCliConfig,
  maskToken,
  updateCliConfig,
} from "../../tooling/weflowctl/src/cli-config.js";

let home: string;
let previousHomeEnv: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "weflow-cli-config-"));
  previousHomeEnv = process.env.WEFLOW_HOME;
  process.env.WEFLOW_HOME = home;
});

afterEach(async () => {
  if (previousHomeEnv === undefined) delete process.env.WEFLOW_HOME;
  else process.env.WEFLOW_HOME = previousHomeEnv;
  await rm(home, { recursive: true, force: true });
});

describe("cli config", () => {
  it("returns an empty config when no file exists", async () => {
    const config = await loadCliConfig();
    expect(config).toEqual({});
    expect(config.registry).toBeUndefined();
  });

  it("persists and reloads values", async () => {
    await updateCliConfig({
      "registry.url": "http://reg.test",
      "registry.token": "secret-token",
      "update.strategy": "patch",
    });
    const config = await loadCliConfig();
    expect(config.registry?.url).toBe("http://reg.test");
    expect(config.registry?.token).toBe("secret-token");
    expect(config.update?.strategy).toBe("patch");
  });

  it("supports store.path and signing.keyFile keys", async () => {
    const config = await updateCliConfig({
      "store.path": "D:\\weflow-store",
      "signing.keyFile": "D:\\keys\\release.pem",
    });
    expect(config.store?.path).toBe("D:\\weflow-store");
    expect(config.signing?.keyFile).toBe("D:\\keys\\release.pem");
  });

  it("rejects unknown keys and invalid update strategies", async () => {
    await expect(updateCliConfig({ "not.a.key": "x" })).rejects.toThrow(
      "unknown_config_key:not.a.key",
    );
    await expect(
      updateCliConfig({ "update.strategy": "weekly" }),
    ).rejects.toThrow("invalid_update_strategy:weekly");
  });

  it("masks tokens for display", () => {
    expect(maskToken("abcdefghijklmnop")).toBe("abcdefgh********");
    expect(maskToken("short")).toBe("*****");
    expect(maskToken(undefined)).toBe("(not set)");
  });

  it("keeps unrelated keys when updating one value", async () => {
    await updateCliConfig({ "registry.url": "http://one.test" });
    await updateCliConfig({ "update.strategy": "minor" });
    const config = await loadCliConfig();
    expect(config.registry?.url).toBe("http://one.test");
    expect(config.update?.strategy).toBe("minor");
  });

  it("writes the config under WEFLOW_HOME/.weflow, not the working directory", async () => {
    await updateCliConfig({ "registry.token": "tok" });
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(home, "config.json"), "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      registry: { token: "tok" },
    });
  });

  it("writes config atomically enough that a partial file fails loudly", async () => {
    // Corrupt the file; loader must throw instead of silently returning {}.
    await updateCliConfig({ "registry.url": "http://x.test" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(home, "config.json"), "{broken", "utf8");
    await expect(loadCliConfig()).rejects.toThrow("config_file_invalid");
  });
});

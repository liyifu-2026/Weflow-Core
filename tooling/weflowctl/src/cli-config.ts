/**
 * Local CLI configuration (~/.weflow/config.json).
 *
 * Stores machine-local CLI state. Never commit this file; tokens are masked
 * by `maskToken` when displayed.
 *
 * R3 平台化拆除：solution registry / auto-update / store / signing 配置段
 * 已随机制删除；config 域保留 get/set/list 骨架供后续平台配置使用。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CliConfig = {
  registry?: {
    url?: string;
    token?: string;
  };
};

export function cliConfigPath(): string {
  return join(
    process.env.WEFLOW_HOME ?? join(homedir(), ".weflow"),
    "config.json",
  );
}

const KNOWN_KEYS = new Set<string>(["registry.url", "registry.token"]);

function setNested(config: CliConfig, key: string, value: unknown): void {
  const [section, leaf] = key.split(".");
  if (section === "registry") {
    config.registry = { ...(config.registry ?? {}) };
    if (value === undefined) {
      if (leaf === "url") delete config.registry.url;
      if (leaf === "token") delete config.registry.token;
      return;
    }
    if (leaf === "url" && typeof value === "string")
      config.registry.url = value;
    if (leaf === "token" && typeof value === "string")
      config.registry.token = value;
  }
}

/** Load the local config; a corrupted file fails loudly instead of resetting. */
export async function loadCliConfig(): Promise<CliConfig> {
  try {
    const raw = await readFile(cliConfigPath(), "utf8");
    return JSON.parse(raw) as CliConfig;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new Error(`config_file_invalid:${cliConfigPath()}`, { cause: error });
  }
}

/** Validate-and-set one or more known config keys, persisting atomically. */
export async function updateCliConfig(
  updates: Record<string, string | boolean | undefined>,
): Promise<CliConfig> {
  for (const key of Object.keys(updates)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`unknown_config_key:${key}`);
  }
  const config = await loadCliConfig();
  for (const [key, value] of Object.entries(updates)) {
    setNested(config, key, value);
  }
  await persist(config);
  return config;
}

async function persist(config: CliConfig): Promise<void> {
  const path = cliConfigPath();
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.tmp`;
  await writeFile(staging, JSON.stringify(config, null, 2), "utf8");
  await rename(staging, path);
}

/** Mask a token for display: keep at most the first 8 characters. */
export function maskToken(token: string | undefined): string {
  if (!token) return "(not set)";
  if (token.length <= 8) return "*".repeat(token.length);
  return `${token.slice(0, 8)}${"*".repeat(8)}`;
}

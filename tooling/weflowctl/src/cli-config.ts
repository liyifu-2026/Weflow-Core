/**
 * Local CLI configuration (~/.weflow/config.json).
 *
 * Stores machine-local CLI state such as registry login tokens and the
 * auto-update strategy. Never commit this file; tokens are masked by
 * `maskToken` when displayed.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  UPDATE_STRATEGIES,
  type SolutionUpdateStrategy,
} from "../../../core/infrastructure/solutions/solution-update.js";

export type CliConfig = {
  registry?: {
    url?: string;
    token?: string;
  };
  update?: {
    strategy?: SolutionUpdateStrategy;
    enabled?: boolean;
  };
  store?: {
    path?: string;
  };
  signing?: {
    keyFile?: string;
  };
};

export function cliConfigPath(): string {
  return join(
    process.env.WEFLOW_HOME ?? join(homedir(), ".weflow"),
    "config.json",
  );
}

const KNOWN_KEYS = new Set<string>([
  "registry.url",
  "registry.token",
  "update.strategy",
  "update.enabled",
  "store.path",
  "signing.keyFile",
]);

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
  if (section === "update") {
    config.update = { ...(config.update ?? {}) };
    if (leaf === "strategy" && typeof value === "string") {
      config.update.strategy = value as SolutionUpdateStrategy;
    }
    if (leaf === "enabled" && typeof value === "boolean") {
      config.update.enabled = value;
    }
  }
  if (section === "store") {
    config.store = { ...(config.store ?? {}) };
    if (value === undefined) {
      if (leaf === "path") delete config.store.path;
      return;
    }
    if (leaf === "path" && typeof value === "string") {
      config.store.path = value;
    }
  }
  if (section === "signing") {
    config.signing = { ...(config.signing ?? {}) };
    if (value === undefined) {
      if (leaf === "keyFile") delete config.signing.keyFile;
      return;
    }
    if (leaf === "keyFile" && typeof value === "string") {
      config.signing.keyFile = value;
    }
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
  for (const [key, value] of Object.entries(updates)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`unknown_config_key:${key}`);
    if (key === "update.strategy" && typeof value === "string") {
      if (!(UPDATE_STRATEGIES as readonly string[]).includes(value)) {
        throw new Error(
          `invalid_update_strategy:${value}:expected ${UPDATE_STRATEGIES.join("|")}`,
        );
      }
    }
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

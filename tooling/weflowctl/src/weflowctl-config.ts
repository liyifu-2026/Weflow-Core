/**
 * `weflowctl config` and `weflowctl completion` command layer.
 *
 * config: read/write the local CLI configuration (see cli-config.ts).
 * completion: emit shell completion scripts for bash/zsh/powershell.
 */
import { loadCliConfig, maskToken, updateCliConfig } from "./cli-config.js";
import { completionFor } from "./cli-completion.js";
import { classifyError } from "./cli-errors.js";

export type ConfigCommandResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; code?: string; hint?: string };

const CONFIG_KEYS = new Set([
  "registry.url",
  "registry.token",
  "update.strategy",
  "update.enabled",
  "store.path",
  "signing.keyFile",
]);

export async function runConfigCommand(
  args: string[],
): Promise<ConfigCommandResult> {
  try {
    const data = await dispatchConfig(args);
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classified = classifyError(message);
    return {
      ok: false,
      error: message,
      code: classified.code,
      ...(classified.hint !== undefined ? { hint: classified.hint } : {}),
    };
  }
}

async function dispatchConfig(
  args: string[],
): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "get": {
      const key = rest[0];
      if (!key) throw new Error("config_key_required");
      if (!CONFIG_KEYS.has(key)) throw new Error(`unknown_config_key:${key}`);
      const config = await loadCliConfig();
      const value =
        key === "registry.url"
          ? config.registry?.url
          : key === "registry.token"
            ? maskToken(config.registry?.token)
            : key === "update.strategy"
              ? config.update?.strategy
              : key === "update.enabled"
                ? config.update?.enabled
                : key === "store.path"
                  ? config.store?.path
                  : config.signing?.keyFile;
      return { key, value: value ?? null };
    }
    case "set": {
      const [key, ...valueParts] = rest;
      const rawValue = valueParts.join(" ");
      if (!key || !CONFIG_KEYS.has(key)) {
        throw new Error(`unknown_config_key:${key ?? "(none)"}`);
      }
      let parsed: string | boolean;
      if (key === "update.enabled") {
        parsed = rawValue === "true";
      } else {
        parsed = rawValue;
      }
      const config = await updateCliConfig({ [key]: parsed });
      return { key, value: flattenValue(config, key) };
    }
    case "list": {
      const config = await loadCliConfig();
      return {
        values: [
          { key: "registry.url", value: config.registry?.url ?? null },
          {
            key: "registry.token",
            value:
              config.registry?.token !== undefined
                ? maskToken(config.registry.token)
                : null,
          },
          {
            key: "update.strategy",
            value: config.update?.strategy ?? null,
          },
          { key: "update.enabled", value: config.update?.enabled ?? false },
          { key: "store.path", value: config.store?.path ?? null },
          { key: "signing.keyFile", value: config.signing?.keyFile ?? null },
        ],
      };
    }
    case undefined:
      throw Object.assign(new Error(USAGE_CONFIG), { usage: true });
    default:
      throw Object.assign(new Error(`unknown_config_command:${subcommand}`), {
        usage: true,
      });
  }
}

function flattenValue(
  config: Awaited<ReturnType<typeof loadCliConfig>>,
  key: string,
): unknown {
  if (key === "registry.url") return config.registry?.url ?? null;
  if (key === "registry.token") return config.registry?.token ?? null;
  if (key === "update.strategy") return config.update?.strategy ?? null;
  if (key === "update.enabled") return config.update?.enabled ?? false;
  if (key === "store.path") return config.store?.path ?? null;
  return config.signing?.keyFile ?? null;
}

const USAGE_CONFIG = `Usage: weflowctl config <subcommand>

Subcommands:
  config get [key]           Print one value (masked when sensitive) or all keys
  config set <key> <value>   Set a value; pass an empty value to clear
  config list                List all known keys with their values

Keys: registry.url | registry.token | update.strategy | update.enabled |
      store.path | signing.keyFile
`;

export function runCompletionCommand(
  args: string[],
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const shell = args[0];
  if (!shell) {
    return {
      ok: false,
      error: "shell_required:expected bash|zsh|powershell",
    };
  }
  try {
    return { ok: true, data: { shell, script: completionFor(shell) } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

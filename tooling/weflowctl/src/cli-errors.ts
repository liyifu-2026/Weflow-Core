/**
 * Central CLI error code registry.
 *
 * Infrastructure modules throw `Error` instances whose messages start with a
 * stable machine-readable code. The CLI maps those messages to codes plus
 * operator-facing hints here, so command layers never hard-code error
 * strings.
 *
 * R3 平台化拆除：solution pack/registry/npm-market 错误码随机制删除，
 * 仅保留 CLI 通用错误。
 */
export const ErrorCodes = {
  Internal: "internal_error",
  Usage: "usage_error",
  UnknownCommand: "unknown_cli_command",
  UnknownDomain: "unknown_cli_domain",
  UnknownConfigKey: "unknown_config_key",
  ConfigFileInvalid: "config_file_invalid",
  UnknownShell: "unknown_shell",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

type Classification = { code: string; hint?: string };

/** Map an infrastructure error message to a stable code plus optional hint. */
export function classifyError(message: string): Classification {
  if (message.startsWith("unknown_config_key")) {
    return {
      code: ErrorCodes.UnknownConfigKey,
      hint: "Run `weflowctl config list` to list known keys.",
    };
  }
  if (message.startsWith("config_file_invalid")) {
    return {
      code: ErrorCodes.ConfigFileInvalid,
      hint: "Fix or delete the corrupted config.json and retry.",
    };
  }
  if (message.startsWith("unknown_shell")) {
    return {
      code: ErrorCodes.UnknownShell,
      hint: "Supported shells: bash | zsh | powershell.",
    };
  }
  if (message.startsWith("unknown_cli_command")) {
    return {
      code: ErrorCodes.UnknownCommand,
      hint: "Run `weflowctl --help` to list available commands.",
    };
  }
  if (
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(
      message,
    )
  ) {
    return {
      code: "network_unreachable",
      hint: "Check the URL and network connectivity.",
    };
  }
  return { code: ErrorCodes.Internal };
}

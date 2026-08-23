/**
 * Central CLI error code registry.
 *
 * Infrastructure modules throw `Error` instances whose messages start with a
 * stable machine-readable code (e.g. `solution_signature_invalid`). The CLI
 * maps those messages to codes plus operator-facing hints here, so command
 * layers never hard-code error strings.
 */
export const ErrorCodes = {
  Internal: "internal_error",
  Usage: "usage_error",
  UnknownCommand: "unknown_solution_command",
  YamlAdapterRequired: "yaml_adapter_required",
  ManifestNotFound: "solution_manifest_not_found",
  ManifestInvalid: "solution_manifest_invalid",
  LockMissing: "solution_lock_missing",
  SignatureMissing: "solution_signature_missing",
  SignatureInvalid: "solution_signature_invalid",
  TrustedKeyRequiredVerify: "trusted_public_key_required_for_production_verify",
  TrustedKeyRequiredInstall: "trusted_public_key_required_for_install",
  TrustedKeyRequiredProductionInstall:
    "trusted_public_key_required_for_production_install",
  ArtifactMissing: "solution_artifact_missing",
  ArtifactPathEscape: "solution_artifact_path_escape",
  ArtifactDigestMismatch: "solution_artifact_digest_mismatch",
  ArtifactSizeMismatch: "solution_artifact_size_mismatch",
  PluginEntryMissing: "plugin_entry_missing",
  VersionNotInStore: "solution_version_not_in_store",
  NotInstalled: "solution_not_installed",
  NotActive: "solution_not_active",
  NoPreviousVersion: "solution_no_previous_version",
  ActivateFailed: "solution_activate_failed",
  HealthCheckFailed: "solution_health_check_failed",
  UpdateRolledBack: "solution_update_rolled_back",
  UpdateStrategyInvalid: "invalid_update_strategy",
  StoreLocked: "store_locked",
  UninstallConfirmRequired: "uninstall_confirm_required",
  PruneKeepInvalid: "prune_keep_invalid",
  RegistryLoginArgsRequired: "registry_login_url_and_token_required",
  RegistryUrlRequired: "registry_url_required",
  KeyImportFileRequired: "key_import_file_required",
  SigningKeyInvalid: "signing_key_invalid",
  SolutionIdRequired: "solution_id_required",
  PackageDirRequired: "package_directory_required",
  SolutionAlreadyActive: "solution_already_active",
  RegistryUnreachable: "registry_unreachable",
  RegistrySolutionNotFound: "registry_solution_not_found",
  RegistryVersionNotFound: "registry_version_not_found",
  RegistryNoVersions: "registry_no_versions",
  RegistryPublishDisabled: "registry_publish_disabled",
  RegistryPublishUnauthorized: "registry_publish_unauthorized",
  RegistryPublishNameInvalid: "registry_publish_name_invalid",
  RegistryHttpError: "registry_http_error",
  RegistryIdMismatch: "solution_registry_id_mismatch",
  RegistryVersionMismatch: "solution_registry_version_mismatch",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

type Classification = { code: string; hint?: string };

/**
 * Prefix table: the longest matching entry wins, so parameterised messages
 * like `registry_version_not_found:<id>:<version>` classify correctly.
 */
const PREFIX_HINTS: Array<{ prefix: string; code: string; hint?: string }> = [
  {
    prefix: "solution_signature_invalid",
    code: ErrorCodes.SignatureInvalid,
    hint: "Re-publish the package with the correct signing key, or pass --trusted-key with the publisher's public key.",
  },
  {
    prefix: "trusted_public_key_required_for_production_verify",
    code: ErrorCodes.TrustedKeyRequiredVerify,
    hint: "Pass --development for local verification, or configure WEFLOW_SOLUTION_TRUSTED_SIGNING_PUBLIC_KEY for production.",
  },
  {
    prefix: "trusted_public_key_required_for_production_install",
    code: ErrorCodes.TrustedKeyRequiredProductionInstall,
    hint: "Provide --trusted-key <pem> or WEFLOW_SOLUTION_TRUSTED_SIGNING_PUBLIC_KEY.",
  },
  {
    prefix: "trusted_public_key_required",
    code: ErrorCodes.TrustedKeyRequiredInstall,
    hint: "Provide --trusted-key <pem>, or ensure the development key exists at ~/.weflow/keys/dev-signing-key.pem.pub.",
  },
  {
    prefix: "solution_signature_missing",
    code: ErrorCodes.SignatureMissing,
    hint: "The package was not published through `weflowctl solution publish`; signature.json is absent.",
  },
  {
    prefix: "solution_lock_missing",
    code: ErrorCodes.LockMissing,
    hint: "The package lacks solution.lock.json; run `weflowctl solution publish` to produce a complete package.",
  },
  {
    prefix: "solution_manifest_not_found",
    code: ErrorCodes.ManifestNotFound,
    hint: "Point the command at a directory containing solution.manifest.yaml (JSON subset).",
  },
  {
    prefix: "solution_manifest_invalid",
    code: ErrorCodes.ManifestInvalid,
    hint: "Validate the manifest with `pnpm weflowctl solution verify <dir> --development` for details.",
  },
  {
    prefix: "solution_version_not_in_store",
    code: ErrorCodes.VersionNotInStore,
    hint: "Run `weflowctl solution install <id|tgz>` first, or configure SOLUTION_REGISTRY_URL for the runner.",
  },
  {
    prefix: "solution_no_previous_version",
    code: ErrorCodes.NoPreviousVersion,
    hint: "Nothing to roll back to; install a previous version first.",
  },
  {
    prefix: "solution_not_active",
    code: ErrorCodes.NotActive,
    hint: "Run `weflowctl solution activate <id>` before rolling back.",
  },
  {
    prefix: "solution_not_installed",
    code: ErrorCodes.NotInstalled,
    hint: "Run `weflowctl solution install <id|tgz>` first.",
  },
  {
    prefix: "solution_activate_failed",
    code: ErrorCodes.ActivateFailed,
    hint: "Check the store directory permissions and retry.",
  },
  {
    prefix: "solution_health_check_failed",
    code: ErrorCodes.HealthCheckFailed,
    hint: "The target version failed its pre-activation health gate; inspect the reported reason.",
  },
  {
    prefix: "solution_update_rolled_back",
    code: ErrorCodes.UpdateRolledBack,
    hint: "The post-activation probe failed and the previous version was restored; investigate before retrying.",
  },
  {
    prefix: "invalid_update_strategy",
    code: ErrorCodes.UpdateStrategyInvalid,
    hint: "Use one of: manual, patch, minor, major.",
  },
  {
    prefix: "registry_version_not_found",
    code: ErrorCodes.RegistryVersionNotFound,
    hint: "Run `weflowctl solution versions <id> --registry <url>` to list available versions.",
  },
  {
    prefix: "registry_solution_not_found",
    code: ErrorCodes.RegistrySolutionNotFound,
    hint: "The registry has no versions for this id; check the id and registry URL.",
  },
  {
    prefix: "registry_no_versions",
    code: ErrorCodes.RegistryNoVersions,
    hint: "The registry index is empty for this id.",
  },
  {
    prefix: "registry_publish_disabled",
    code: ErrorCodes.RegistryPublishDisabled,
    hint: "Start the registry with WEFLOW_SOLUTION_REGISTRY_TOKEN set to enable publishing.",
  },
  {
    prefix: "registry_publish_unauthorized",
    code: ErrorCodes.RegistryPublishUnauthorized,
    hint: "Pass the correct token via --registry-token or WEFLOW_SOLUTION_REGISTRY_TOKEN.",
  },
  {
    prefix: "registry_publish_name_invalid",
    code: ErrorCodes.RegistryPublishNameInvalid,
    hint: "Publish from a `weflowctl solution publish` output tarball named <id>-<version>.tgz.",
  },
  {
    prefix: "solution_registry_id_mismatch",
    code: ErrorCodes.RegistryIdMismatch,
    hint: "The package contents do not match the target solution id.",
  },
  {
    prefix: "solution_registry_version_mismatch",
    code: ErrorCodes.RegistryVersionMismatch,
    hint: "The package contents do not match the target version.",
  },
  {
    prefix: "registry_http_error",
    code: ErrorCodes.RegistryHttpError,
  },
  {
    prefix: "yaml_adapter_required",
    code: ErrorCodes.YamlAdapterRequired,
    hint: "Only the JSON subset of YAML is accepted for manifests.",
  },
  {
    prefix: "solution_plugin_entry_not_found",
    code: ErrorCodes.PluginEntryMissing,
    hint: "The plugin artifact needs src/plugin.ts, a package main, or dist/plugin.js.",
  },
  {
    prefix: "solution_artifact_missing",
    code: ErrorCodes.ArtifactMissing,
    hint: "The manifest references an artifact directory that does not exist.",
  },
  {
    prefix: "solution_artifact_path_escape",
    code: ErrorCodes.ArtifactPathEscape,
    hint: "The lock references a path outside the package directory; republish from a trusted source tree.",
  },
  {
    prefix: "solution_artifact_digest_mismatch",
    code: ErrorCodes.ArtifactDigestMismatch,
    hint: "Artifact contents changed after signing; re-run `weflowctl solution publish`.",
  },
  {
    prefix: "solution_artifact_size_mismatch",
    code: ErrorCodes.ArtifactSizeMismatch,
    hint: "Artifact byte size differs from the lock entry; the package is corrupt or tampered.",
  },
];

/** Map an infrastructure error message to a stable code plus optional hint. */
export function classifyError(message: string): Classification {
  const match = PREFIX_HINTS.find((entry) => message.startsWith(entry.prefix));
  if (match) {
    return { code: match.code, ...(match.hint ? { hint: match.hint } : {}) };
  }
  if (message.startsWith("unknown_solution_command")) {
    return {
      code: ErrorCodes.UnknownCommand,
      hint: "Run `weflowctl solution --help` to list available commands.",
    };
  }
  const directHints: Array<[string, string]> = [
    [
      "uninstall_confirm_required",
      "This permanently removes all installed versions. Re-run with --yes.",
    ],
    [
      "registry_login_url_and_token_required",
      "Provide both --url and --token for registry login.",
    ],
    [
      "registry_url_required",
      "Pass --registry <url>, run `registry login`, or set WEFLOW_SOLUTION_REGISTRY_URL.",
    ],
    ["prune_keep_invalid", "--keep must be a positive integer."],
    [
      "key_import_file_required",
      "Pass --key-file <path> with the private key to import.",
    ],
    [
      "signing_key_invalid",
      "The file is not a readable PKCS8 private key PEM.",
    ],
    ["solution_id_required", "Pass the solution id as the first argument."],
    [
      "package_directory_required",
      "Pass the package directory or tarball path.",
    ],
  ];
  for (const [prefix, hint] of directHints) {
    if (message.startsWith(prefix)) {
      return { code: prefix, hint };
    }
  }
  if (message.startsWith("prune_keep_invalid")) {
    return { code: ErrorCodes.PruneKeepInvalid, hint: "--keep must be >= 1" };
  }
  if (
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(
      message,
    )
  ) {
    return {
      code: ErrorCodes.RegistryUnreachable,
      hint: "Check the registry URL and network connectivity.",
    };
  }
  return { code: ErrorCodes.Internal };
}

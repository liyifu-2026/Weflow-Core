/**
 * `weflowctl solution` command layer.
 *
 * Thin orchestration over the solution infrastructure modules. Commands parse
 * arguments, delegate to infrastructure, and return typed `CommandResult`s 鈥? * they never touch process streams or exit codes, so the entry point can
 * render through any CliOutput implementation and tests can assert on data.
 */
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultDevSigningKeyPath,
  installSolutionPackage,
  packSolution,
} from "../../../core/infrastructure/solutions/solution-pack.js";
import {
  activateSolution,
  rollbackSolution,
  deactivateSolution,
  existsInStore,
  listInstalledVersions,
  pruneSolutionVersions,
  readActiveVersion,
  readActivationHistory,
  removeSolution,
  storeSolutions,
} from "../../../core/infrastructure/solutions/solution-store.js";
import {
  rollbackSolutionTo,
  updateSolutionInStore,
  type UpdateSolutionOutcome,
} from "../../../core/infrastructure/solutions/solution-upgrade.js";
import {
  downloadSolutionTarball,
  fetchRegistryVersions,
  publishSolutionTarball,
  searchRegistry,
} from "../../../core/infrastructure/solutions/solution-registry-client.js";
import {
  UPDATE_STRATEGIES,
  isSolutionUpdateStrategy,
} from "../../../core/infrastructure/solutions/solution-update.js";
import { checkSolutionVersionHealth } from "../../../core/infrastructure/solutions/solution-health.js";
import {
  exportPublicKey,
  importSigningKey,
  listSigningKeys,
} from "../../../core/infrastructure/solutions/solution-keys.js";
import {
  describeSolutionPackage,
  assertSolutionArtifacts,
  type SolutionPackageFiles,
} from "@weflow/solution-sdk";
import { ErrorCodes, classifyError } from "./cli-errors.js";
import { loadCliConfig, maskToken, updateCliConfig } from "./cli-config.js";
import { runSolutionDoctor } from "../../../core/infrastructure/solutions/solution-doctor.js";
import { inspectPackage } from "../../../core/infrastructure/solutions/solution-inspect.js";
import {
  exportSolutionBackup,
  importSolutionBackup,
} from "../../../core/infrastructure/solutions/solution-export-import.js";
import { appendAuditLog } from "../../../core/infrastructure/solutions/solution-audit.js";
import { resolveUpdateTarget } from "../../../core/infrastructure/solutions/solution-update.js";

/** Commands whose successful invocation is recorded in the audit log. */
const AUDITED_COMMANDS = new Set([
  "publish",
  "install",
  "activate",
  "update",
  "rollback",
  "disable",
  "uninstall",
  "prune",
  "keygen",
]);

export type CommandResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; hint?: string };

/** Per-command result shapes (documented contract for --json consumers). */
export type VerifyResult = {
  valid: boolean;
  solutionId: string;
  version: string;
  manifestDigest: string;
  lockDigest?: string;
  signatureKeyId: string;
  mode: string;
  signatureVerified: boolean;
  artifactsVerified?: number;
  note: string;
};

export type DigestResult = { manifestDigest: string; lockDigest?: string };

export type PublishResult = {
  tgzPath: string;
  solutionId: string;
  version: string;
  manifestDigest: string;
  registry?: { version: string; [key: string]: unknown };
};

export type InstallResult = {
  solutionId: string;
  version: string;
  manifestDigest: string;
  storeDir: string;
  source?: string;
  activated?: boolean;
};

export type ActivateResult = { solutionId: string; activeVersion: string };

export type UpdateResult = UpdateSolutionOutcome;

export type RollbackResult = { from: string; to: string };

export type SolutionListRow = {
  solutionId: string;
  installedVersions: string[];
  activeVersion: string | null;
};

export type ListResult =
  | {
      solutions: SolutionListRow[];
    }
  | SolutionListRow;

export type HelpResult = { help: string };

const USAGE = `Usage: pnpm weflowctl solution <command> [args]

Commands:
  keygen                                    Generate an ed25519 signing key pair
  key list|import|export                    Manage local signing keys
  registry login|logout|status              Manage registry login state
  info <id>                                 Install state, manifest metadata and health
  search <keyword>                          Search the registry by keyword
  versions <id>                             List local (and registry) versions
  history <id>                              Activation/rollback history
  verify <package-dir> [--development]      Verify manifest+lock+signature consistency
  digest <package-dir>                      Print the canonical manifest digest
  publish <source-dir> [--out <dir>] [--registry <url>]
                                            Stage, lock, sign and emit a self-contained .tgz
  install <dir|tgz|id> [--registry <url>] [--version <v>] [--trusted-key <pem-path>]
                                            Verify and install a package into the store
  activate <solution-id> [version]          Switch the active junction (default: highest installed)
  update <solution-id> --strategy manual|patch|minor|major [--registry <url>]
                                            Health-checked upgrade with automatic rollback
  rollback <solution-id> [--to <version>]   Switch back to a previous version
  disable <solution-id>                     Deactivate (remove active junction, keep files)
  uninstall <solution-id> [--yes]           Remove every installed version from the store
  prune <solution-id> [--keep <n>]          Delete old non-active versions (default keep 3)
  list [solution-id]                        Show installed versions and the active version

Global flags: --json (structured output), --quiet (errors only), --help
Run "weflowctl solution <command> --help" for per-command details.
`;

type HelpTopic = {
  usage: string;
  description: string;
  details: string[];
  examples: string[];
};

const HELP_TOPICS: Record<string, HelpTopic> = {
  publish: {
    usage:
      "publish <source-dir> [--out <dir>] [--key <pem-path>] [--key-id <id>] [--registry <url>] [--registry-token <token>]",
    description: "Stage, lock, sign and emit a self-contained .tgz package.",
    details: [
      "Stages the source tree, bundles plugin entries with esbuild, writes",
      "solution.lock.json and signature.json, then emits <id>-<version>.tgz.",
      "With --registry the tarball is pushed after packing (token required).",
    ],
    examples: [
      "weflowctl solution publish ../../weflow-solution-customer-support",
      "weflowctl solution publish ./my-solution --registry http://reg.test",
    ],
  },
  keygen: {
    usage: "keygen",
    description: "Generate the ed25519 development signing key pair.",
    details: [
      "Creates ~/.weflow/keys/dev-signing-key.pem(.pub) on first use and",
      "prints the public key fingerprint. Existing keys are kept.",
    ],
    examples: ["weflowctl solution keygen"],
  },
  key: {
    usage:
      "key list | key import --key-file <path> [--name <name>] | key export [--key <pem-path>]",
    description: "Manage local signing keys under ~/.weflow/keys/.",
    details: [
      "list: every local pair with its sha256 fingerprint.",
      "import: copy a foreign PKCS8 private key and derive its public key.",
      "export: print a public key PEM (default dev key unless --key given).",
    ],
    examples: [
      "weflowctl solution key list --json",
      "weflowctl solution key import --key-file ./release.pem --name release",
      "weflowctl solution key export",
    ],
  },
  registry: {
    usage:
      "registry login --url <url> --token <token> | registry logout | registry status",
    description: "Manage registry login state stored in ~/.weflow/config.json.",
    details: [
      "After login, publish/install/update resolve the URL and token from the",
      "stored credentials unless overridden with explicit flags.",
    ],
    examples: [
      "weflowctl solution registry login --url http://reg.test --token t0k",
      "weflowctl solution registry status --json",
    ],
  },
  info: {
    usage: "info <solution-id>",
    description:
      "Show install state, manifest metadata and health for one solution.",
    details: [
      "Includes installed versions, active version, artifact/application",
      "summary and the structural health result of the active version.",
    ],
    examples: ["weflowctl solution info weflow.demo --json"],
  },
  search: {
    usage: "search <keyword> [--registry <url>]",
    description: "Search registry solution ids containing the keyword.",
    details: ["Case-insensitive substring match over registered ids."],
    examples: ["weflowctl solution search support"],
  },
  versions: {
    usage: "versions <solution-id> [--registry <url>]",
    description: "List installed and (optionally) registry versions.",
    details: ["Registry lookup failures are reported as an absent field."],
    examples: [
      "weflowctl solution versions weflow.demo --registry http://reg.test",
    ],
  },
  history: {
    usage: "history <solution-id>",
    description:
      "Show the activation/rollback history recorded in the store lockfile.",
    details: ["Newest first; pruned versions drop out of the history."],
    examples: ["weflowctl solution history weflow.demo"],
  },
  disable: {
    usage: "disable <solution-id>",
    description:
      "Deactivate a solution by removing the active junction (files stay).",
    details: [
      "Store-level operation. The DB desiredState should be synced via the",
      "Console or the Runner operation queue.",
    ],
    examples: ["weflowctl solution disable weflow.demo"],
  },
  uninstall: {
    usage: "uninstall <solution-id> [--yes]",
    description: "Remove every installed version of a solution from the store.",
    details: [
      "Destructive: requires --yes. Lockfile entries and activation history",
      "are removed together with the files.",
    ],
    examples: ["weflowctl solution uninstall weflow.demo --yes"],
  },
  prune: {
    usage: "prune <solution-id> [--keep <n>]",
    description:
      "Delete old non-active versions, keeping the newest n (default 3).",
    details: ["The active version is always preserved regardless of age."],
    examples: ["weflowctl solution prune weflow.demo --keep 2"],
  },
  doctor: {
    usage: "doctor [--registry <url>]",
    description: "One-shot environment health report for the solution store.",
    details: [
      "Checks store root, lockfile, active junctions, package integrity,",
      "signature trust anchor, registry reachability (when configured) and",
      "orphan directories. Every failure carries a repair hint.",
    ],
    examples: ["weflowctl solution doctor --json"],
  },
  inspect: {
    usage: "inspect <tgz|dir>",
    description: "Look inside a package without installing it.",
    details: [
      "Prints manifest summary (id/version/publisher), lock artifacts,",
      "signature key id and the full file listing with sizes.",
    ],
    examples: ["weflowctl solution inspect ./dist/weflow.demo-1.0.0.tgz"],
  },
  export: {
    usage: "export <solution-id> --output <backup.tgz>",
    description: "Back up the active version into a verifiable tarball.",
    details: [
      "The backup is the packaged active version; import verifies it through",
      "the normal signature path before restoring.",
    ],
    examples: [
      "weflowctl solution export weflow.demo --output demo-backup.tgz",
    ],
  },
  import: {
    usage: "import <backup.tgz> [--trusted-key <pem-path>] [--force]",
    description: "Restore a backup into the store and activate it.",
    details: [
      "Signature verification is mandatory. A conflicting installed version",
      "blocks the restore unless --force is given.",
    ],
    examples: ["weflowctl solution import demo-backup.tgz --force"],
  },
  "auto-update": {
    usage:
      "auto-update on --strategy manual|patch|minor|major | auto-update off | auto-update status [--dry-run --solution-id <id>]",
    description: "Manage the local automatic update policy.",
    details: [
      "The policy lives in ~/.weflow/config.json and drives scheduled checks.",
      "status with --dry-run previews which version the strategy would pick.",
    ],
    examples: [
      "weflowctl solution auto-update on --strategy patch",
      "weflowctl solution auto-update status --dry-run --solution-id weflow.demo",
    ],
  },
  install: {
    usage:
      "install <dir|tgz|solution-id> [--registry <url>] [--version <v>] [--trusted-key <pem-path>]",
    description:
      "Verify a package and install it into the store (does not activate).",
    details: [
      "Accepts a package directory, a .tgz path, or a bare solution id.",
      "A bare id requires --registry (or WEFLOW_SOLUTION_REGISTRY_URL) and is",
      "downloaded, signature-verified, then installed into the store.",
    ],
    examples: [
      "weflowctl solution install ./dist/weflow.demo-1.0.0.tgz",
      "weflowctl solution install weflow.demo --registry http://reg.test",
    ],
  },
  activate: {
    usage: "activate <solution-id> [version]",
    description: "Atomically switch the active junction to a store version.",
    details: [
      "Without an explicit version the highest installed version is used.",
      "The switch is atomic (directory junction); the activation is recorded",
      "in the store lockfile for later rollback.",
    ],
    examples: [
      "weflowctl solution activate weflow.demo",
      "weflowctl solution activate weflow.demo 1.1.0",
    ],
  },
  update: {
    usage:
      "update <solution-id> --strategy manual|patch|minor|major [--version <v>] [--registry <url>]",
    description: "Health-checked upgrade with automatic rollback on failure.",
    details: [
      "patch: same major.minor; minor: same major; major: any newer version.",
      "manual requires --version from the candidate set.",
      "With --registry, candidates include registry versions and missing",
      "targets are downloaded before the pre-activation health gate runs.",
    ],
    examples: [
      "weflowctl solution update weflow.demo --strategy minor",
      "weflowctl solution update weflow.demo --strategy manual --version 1.2.0",
    ],
  },
  rollback: {
    usage: "rollback <solution-id> [--to <version>]",
    description: "Switch back to a previous version.",
    details: [
      "Without --to: uses the activation history in the store lockfile",
      "(falls back to the highest installed version below the current one).",
      "With --to: the target must be installed and pass its health gate.",
    ],
    examples: [
      "weflowctl solution rollback weflow.demo",
      "weflowctl solution rollback weflow.demo --to 1.0.0",
    ],
  },
  list: {
    usage: "list [solution-id]",
    description: "Show installed versions and the active version.",
    details: [
      "With an id: single solution detail. Without: every solution in the store.",
      "Default output is a table; add --json for structured rows.",
    ],
    examples: [
      "weflowctl solution list",
      "weflowctl solution list weflow.demo --json",
    ],
  },
  verify: {
    usage: "verify <package-dir> [--development]",
    description:
      "Verify manifest+lock+signature consistency of a package directory.",
    details: [
      "Development mode checks internal consistency without a trust anchor.",
      "Production verification requires a trusted public key and is not",
      "implemented in the CLI yet.",
    ],
    examples: [
      "weflowctl solution verify ./dist/weflow.demo-1.0.0 --development",
    ],
  },
  digest: {
    usage: "digest <package-dir>",
    description: "Print the canonical manifest digest of a package.",
    details: ["The digest covers the normalized manifest via canonical JSON."],
    examples: ["weflowctl solution digest ./dist/weflow.demo-1.0.0"],
  },
};

const VALUE_FLAGS = new Set([
  "--out",
  "--output",
  "--key",
  "--key-id",
  "--key-file",
  "--name",
  "--trusted-key",
  "--strategy",
  "--version",
  "--to",
  "--keep",
  "--registry",
  "--registry-token",
  "--url",
  "--token",
  "--solution-id",
]);

type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | true>;
};

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) break;
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg)) {
        flags[arg] = args[index + 1] ?? "";
        index += 1;
      } else {
        flags[arg] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function renderHelp(topic: HelpTopic): string {
  return [
    `Usage: weflowctl solution ${topic.usage}`,
    "",
    topic.description,
    "",
    ...topic.details.map((line) => `  ${line}`),
    "",
    "Examples:",
    ...topic.examples.map((example) => `  ${example}`),
    "",
  ].join("\n");
}

function stringFlag(
  flags: Record<string, string | true>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export async function runSolutionCommand(
  args: string[],
): Promise<CommandResult> {
  try {
    if (args.includes("--help")) {
      const topicName = args.find((item) => item !== "--help");
      if (!topicName) {
        return { ok: true, data: { help: USAGE } satisfies HelpResult };
      }
      const topic = HELP_TOPICS[topicName];
      if (!topic) {
        return {
          ok: false,
          error: `unknown_solution_command:${topicName}`,
          code: ErrorCodes.UnknownCommand,
          hint: `Known commands: ${Object.keys(HELP_TOPICS).join(", ")}`,
        };
      }
      return {
        ok: true,
        data: { help: renderHelp(topic) } satisfies HelpResult,
      };
    }
    const data = await dispatch(args);
    await auditWriteCommand(args, data);
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const classified = classifyError(message);
    await auditWriteCommand(args, undefined, message);
    return {
      ok: false,
      error: message,
      code: classified.code,
      ...(classified.hint !== undefined ? { hint: classified.hint } : {}),
    };
  }
}

/** Best-effort audit trail for write operations; never blocks the command. */
async function auditWriteCommand(
  args: string[],
  data: Record<string, unknown> | undefined,
  failure?: string,
): Promise<void> {
  const command = args[0];
  if (!command || !AUDITED_COMMANDS.has(command)) return;
  try {
    await appendAuditLog({
      action: command,
      ...(typeof data?.solutionId === "string"
        ? { solutionId: data.solutionId }
        : typeof args[1] === "string" && !args[1].startsWith("--")
          ? { solutionId: args[1] }
          : {}),
      ...(data !== undefined && typeof data.version === "string"
        ? { version: data.version }
        : {}),
      result: failure === undefined ? "success" : "failure",
      ...(failure !== undefined ? { errorCode: failure } : {}),
    });
  } catch {
    // Audit logging must never break the command itself.
  }
}

export { USAGE as SOLUTION_USAGE };

async function dispatch(args: string[]): Promise<Record<string, unknown>> {
  const [command, ...rest] = args;
  switch (command) {
    case "keygen":
      return keygenCommand(rest);
    case "key":
      return keyCommand(rest);
    case "registry":
      return registryCommand(rest);
    case "info":
      return infoCommand(rest);
    case "search":
      return searchCommand(rest);
    case "versions":
      return versionsCommand(rest);
    case "history":
      return historyCommand(rest);
    case "disable":
      return disableCommand(rest);
    case "uninstall":
      return uninstallCommand(rest);
    case "prune":
      return pruneCommand(rest);
    case "doctor":
      return doctorCommand(rest);
    case "inspect":
      return inspectCommand(rest);
    case "export":
      return exportCommand(rest);
    case "import":
      return importBackupCommand(rest);
    case "auto-update":
      return autoUpdateCommand(rest);
    case "verify":
      return verifyCommand(rest);
    case "digest":
      return digestCommand(rest);
    case "publish":
      return publishCommand(rest);
    case "install":
      return installCommand(rest);
    case "activate":
      return activateCommand(rest);
    case "update":
      return updateCommand(rest);
    case "rollback":
      return rollbackCommand(rest);
    case "list":
      return listCommand(rest);
    case undefined:
      throw Object.assign(new Error(USAGE), { usage: true });
    default:
      throw Object.assign(new Error(`unknown_solution_command:${command}`), {
        usage: true,
      });
  }
}

async function keygenCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { generateSigningKey } =
    await import("../../../core/infrastructure/solutions/solution-pack.js");
  const { createHash } = await import("node:crypto");
  const keyPath =
    stringFlag(parseArgs(rawArgs).flags, "--key") ?? defaultDevSigningKeyPath();
  const { keyPair } = await generateSigningKey(resolve(keyPath));
  const fingerprint = createHash("sha256")
    .update(keyPair.publicKeyPem)
    .digest("hex")
    .slice(0, 32);
  return {
    privateKeyPath: resolve(keyPath),
    publicKeyPath: `${resolve(keyPath)}.pub`,
    fingerprint: `sha256:${fingerprint}`,
  };
}

/** ---- Key management (key list / import / export) ---- */

async function keyCommand(rawArgs: string[]): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = rawArgs;
  switch (subcommand) {
    case "list":
      return { keys: await listSigningKeys() };
    case "import": {
      const { flags } = parseArgs(rest);
      const keyFile = stringFlag(flags, "--key-file");
      if (!keyFile) throw new Error("key_import_file_required");
      const name = stringFlag(flags, "--name");
      return importSigningKey(resolve(keyFile), {
        ...(name !== undefined ? { name } : {}),
      });
    }
    case "export": {
      const { flags } = parseArgs(rest);
      const keyFile = stringFlag(flags, "--key");
      if (keyFile) {
        const publicKeyPem = await readFile(`${resolve(keyFile)}.pub`, "utf8");
        return {
          publicKeyPem,
          path: `${resolve(keyFile)}.pub`,
        };
      }
      const exported = await exportPublicKey();
      return { ...exported, path: `${defaultDevSigningKeyPath()}.pub` };
    }
    case undefined:
      throw Object.assign(new Error(USAGE_KEY), { usage: true });
    default:
      throw Object.assign(new Error(`unknown_key_command:${subcommand}`), {
        usage: true,
      });
  }
}

const USAGE_KEY = `Usage: weflowctl solution key <subcommand>

Subcommands:
  key list                        List local signing keys with fingerprints
  key import --key-file <path> [--name <name>]
                                  Import a PKCS8 private key and derive its public key
  key export [--key <pem-path>]   Print the public key PEM and its path
`;

/** ---- Registry login state (login / logout / status) ---- */

async function registryCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = rawArgs;
  const { flags } = parseArgs(rest);
  switch (subcommand) {
    case "login": {
      const url = stringFlag(flags, "--url");
      const token = stringFlag(flags, "--token");
      if (!url || !token) {
        throw new Error("registry_login_url_and_token_required");
      }
      await updateCliConfig({ "registry.url": url, "registry.token": token });
      return { loggedIn: true, url };
    }
    case "logout": {
      const config = await loadCliConfig();
      if (!config.registry?.url && !config.registry?.token) {
        return { loggedIn: false };
      }
      await updateCliConfig({
        "registry.url": undefined,
        "registry.token": undefined,
      });
      return { loggedIn: false };
    }
    case "status": {
      const config = await loadCliConfig();
      return {
        loggedIn: Boolean(config.registry?.url),
        url: config.registry?.url,
        token: maskToken(config.registry?.token),
      };
    }
    case undefined:
      throw Object.assign(new Error(USAGE_REGISTRY), { usage: true });
    default:
      throw Object.assign(new Error(`unknown_registry_command:${subcommand}`), {
        usage: true,
      });
  }
}

const USAGE_REGISTRY = `Usage: weflowctl solution registry <subcommand>

Subcommands:
  registry login --url <url> --token <token>   Store registry credentials locally
  registry logout                              Clear stored credentials
  registry status                              Show the current login state (token masked)
`;

/**
 * Resolve the effective registry context: explicit flag > logged-in config >
 * environment. Tokens follow the same precedence but only match the logged-in
 * URL.
 */
async function resolveRegistryContext(
  flags: Record<string, string | true>,
): Promise<{ url: string; token?: string }> {
  const config = await loadCliConfig();
  const url =
    stringFlag(flags, "--registry") ??
    config.registry?.url ??
    process.env.WEFLOW_SOLUTION_REGISTRY_URL;
  if (!url) throw new Error("registry_url_required");
  const flagToken = stringFlag(flags, "--registry-token");
  const storedRegistry = config.registry;
  const storedToken =
    storedRegistry !== undefined && storedRegistry.url === url
      ? storedRegistry.token
      : undefined;
  const token =
    flagToken ?? storedToken ?? process.env.WEFLOW_SOLUTION_REGISTRY_TOKEN;
  return { url, ...(token !== undefined ? { token } : {}) };
}

/** ---- Query / information commands ---- */

async function infoCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { positionals } = parseArgs(rawArgs);
  const id = positionals[0];
  if (!id) throw new Error("solution_id_required");
  const installedVersions = await listInstalledVersions(id);
  const activeVersion = await readActiveVersion(id);
  let manifestInfo: Record<string, unknown> | undefined;
  let health: Record<string, unknown> | undefined;
  if (activeVersion) {
    const { getSolutionStoreRoot } =
      await import("../../../core/infrastructure/solutions/solution-store.js");
    const { describeStagedSolution } =
      await import("../../../core/infrastructure/solutions/solution-pack.js");
    const activeDir = join(getSolutionStoreRoot(), id, activeVersion);
    try {
      const descriptor = await describeStagedSolution(activeDir);
      manifestInfo = {
        name: descriptor.manifest.metadata.name,
        publisher: descriptor.manifest.metadata.publisher,
        artifactCount: descriptor.manifest.artifacts.length,
        applications: descriptor.manifest.applications.map((item) => item.id),
        compatibility: descriptor.manifest.compatibility,
      };
    } catch {
      manifestInfo = { error: "manifest_unreadable" };
    }
    const healthResult = await checkSolutionVersionHealth(activeDir);
    health = healthResult.ok
      ? { ok: true }
      : { ok: false, reason: healthResult.reason };
  }
  return {
    solutionId: id,
    installedVersions,
    activeVersion,
    ...(manifestInfo !== undefined ? { manifest: manifestInfo } : {}),
    ...(health !== undefined ? { health } : {}),
  };
}

async function searchCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseArgs(rawArgs);
  const keyword = positionals[0] ?? "";
  const { url, token } = await resolveRegistryContext(flags);
  const results = await searchRegistry(
    url,
    keyword,
    token !== undefined ? { token } : {},
  );
  return { keyword, results };
}

async function versionsCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseArgs(rawArgs);
  const id = positionals[0];
  if (!id) throw new Error("solution_id_required");
  const installed = await listInstalledVersions(id);
  let registryUrl =
    stringFlag(flags, "--registry") ?? process.env.WEFLOW_SOLUTION_REGISTRY_URL;
  let registryToken: string | undefined;
  if (registryUrl) {
    const context = await resolveRegistryContext(flags);
    registryUrl = context.url;
    registryToken = context.token;
  }
  let registryVersions: string[] | undefined;
  if (registryUrl) {
    registryVersions = await fetchRegistryVersions(
      registryUrl,
      id,
      registryToken !== undefined ? { token: registryToken } : {},
    ).catch(() => undefined);
  }
  return {
    solutionId: id,
    installed,
    ...(registryVersions !== undefined ? { registry: registryVersions } : {}),
  };
}

async function historyCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { positionals } = parseArgs(rawArgs);
  const id = positionals[0];
  if (!id) throw new Error("solution_id_required");
  return { solutionId: id, history: await readActivationHistory(id) };
}

/** ---- Lifecycle completion ---- */

async function disableCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { positionals } = parseArgs(rawArgs);
  const id = positionals[0];
  if (!id) throw new Error("solution_id_required");
  const removedActive = await deactivateSolution(id);
  return {
    solutionId: id,
    disabled: true,
    activeRemoved: removedActive,
    note: "Store-level disable. Sync DB desiredState via the Console or the Runner operation queue.",
  };
}

async function uninstallCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseArgs(rawArgs);
  const id = positionals[0];
  if (!id) throw new Error("solution_id_required");
  if (flags["--yes"] !== true) {
    throw Object.assign(new Error("uninstall_confirm_required"), {
      hint: "This permanently removes all installed versions. Re-run with --yes.",
    });
  }
  const result = await removeSolution(id);
  return {
    solutionId: id,
    uninstalled: true,
    removedVersions: result.removedVersions,
    note: "Store-level uninstall. Sync DB desiredState via the Console or the Runner operation queue.",
  };
}

async function pruneCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseArgs(rawArgs);
  const id = positionals[0];
  if (!id) throw new Error("solution_id_required");
  const keepRaw = stringFlag(flags, "--keep") ?? "3";
  const keep = Number.parseInt(keepRaw, 10);
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`prune_keep_invalid:${keepRaw}`);
  }
  return { solutionId: id, ...(await pruneSolutionVersions(id, keep)) };
}

/** ---- Operations: doctor / inspect / export / import / auto-update ---- */

async function doctorCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { flags } = parseArgs(rawArgs);
  const registryUrl =
    stringFlag(flags, "--registry") ?? process.env.WEFLOW_SOLUTION_REGISTRY_URL;
  let registryToken: string | undefined;
  if (registryUrl) {
    const context = await resolveRegistryContext(flags);
    registryToken = context.token;
  }
  const report = await runSolutionDoctor({
    ...(registryUrl !== undefined ? { registryUrl } : {}),
    ...(registryToken !== undefined ? { registryToken } : {}),
  });
  return { ok: report.ok, checks: report.checks };
}

async function inspectCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { positionals } = parseArgs(rawArgs);
  const input = positionals[0];
  if (!input) throw new Error("package_path_required");
  return { ...(await inspectPackage(input)) };
}

async function exportCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseArgs(rawArgs);
  const id = positionals[0];
  if (!id) throw new Error("solution_id_required");
  const output = stringFlag(flags, "--output");
  if (!output) throw new Error("export_output_required");
  return await exportSolutionBackup(id, resolve(output));
}

async function importBackupCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseArgs(rawArgs);
  const input = positionals[0];
  if (!input) throw new Error("backup_path_required");
  const trustedKeyFlag = stringFlag(flags, "--trusted-key");
  const trustedPublicKeyPem = trustedKeyFlag
    ? await readFile(resolve(trustedKeyFlag), "utf8")
    : undefined;
  return await importSolutionBackup(resolve(input), {
    mode: "development",
    ...(trustedPublicKeyPem !== undefined ? { trustedPublicKeyPem } : {}),
    force: flags["--force"] === true,
  });
}

async function autoUpdateCommand(
  rawArgs: string[],
): Promise<Record<string, unknown>> {
  const [subcommand, ...rest] = rawArgs;
  const { flags } = parseArgs(rest);
  switch (subcommand) {
    case "on": {
      const strategy = stringFlag(flags, "--strategy") ?? "patch";
      if (!isSolutionUpdateStrategy(strategy)) {
        throw new Error(
          `invalid_update_strategy:${strategy}:expected ${UPDATE_STRATEGIES.join("|")}`,
        );
      }
      await updateCliConfig({
        "update.enabled": true,
        "update.strategy": strategy,
      });
      return { enabled: true, strategy };
    }
    case "off": {
      await updateCliConfig({ "update.enabled": false });
      return { enabled: false };
    }
    case "status": {
      const config = await loadCliConfig();
      const enabled = config.update?.enabled === true;
      const strategy: string = config.update?.strategy ?? "manual";
      let preview: Record<string, unknown> | undefined;
      if (rest.includes("--dry-run")) {
        const solutionId = stringFlag(flags, "--solution-id");
        if (!solutionId) throw new Error("solution_id_required");
        const current = await readActiveVersion(solutionId);
        const installed = await listInstalledVersions(solutionId);
        const explicitVersion = stringFlag(flags, "--version");
        if (!isSolutionUpdateStrategy(strategy)) {
          throw new Error(
            `invalid_update_strategy:${strategy}:expected ${UPDATE_STRATEGIES.join("|")}`,
          );
        }
        const target = resolveUpdateTarget({
          candidates: installed,
          current,
          strategy,
          ...(explicitVersion !== undefined ? { explicitVersion } : {}),
        });
        preview =
          target === null
            ? { action: "none", current }
            : { action: "would-update", from: current, to: target };
      }
      return {
        enabled,
        strategy,
        ...(preview !== undefined ? { preview } : {}),
      };
    }
    case undefined:
      throw Object.assign(new Error(USAGE_AUTO_UPDATE), { usage: true });
    default:
      throw Object.assign(
        new Error(`unknown_auto_update_command:${subcommand}`),
        { usage: true },
      );
  }
}

const USAGE_AUTO_UPDATE = `Usage: weflowctl solution auto-update <subcommand>

Subcommands:
  auto-update on --strategy manual|patch|minor|major   Enable automatic updates
  auto-update off                                      Disable automatic updates
  auto-update status [--dry-run --solution-id <id>]    Show state; optionally preview the next update
`;

async function verifyCommand(rawArgs: string[]): Promise<VerifyResult> {
  const { positionals } = parseArgs(rawArgs);
  const input = positionals[0];
  if (!input) throw new Error("package_directory_required");
  if (!rawArgs.includes("--development")) {
    throw new Error("trusted_public_key_required_for_production_verify");
  }
  const packageDir = resolve(input);
  const files = await readPackageFiles(packageDir);
  const descriptor = describeSolutionPackage(files);
  // 产物校验统一走 SDK：路径逃逸 + sha256 摘要 + size 一致性。
  const verified = await assertSolutionArtifacts(descriptor, packageDir);
  return {
    valid: true,
    solutionId: descriptor.manifest.metadata.id,
    version: descriptor.manifest.metadata.version,
    manifestDigest: descriptor.manifestDigest,
    ...(descriptor.lockDigest !== undefined
      ? { lockDigest: descriptor.lockDigest }
      : {}),
    signatureKeyId: descriptor.signature.keyId,
    mode: "development",
    signatureVerified: false,
    artifactsVerified: verified.length,
    note: "Development package verification does not authorize production installation.",
  };
}

async function digestCommand(rawArgs: string[]): Promise<DigestResult> {
  const { positionals } = parseArgs(rawArgs);
  const input = positionals[0];
  if (!input) throw new Error("package_directory_required");
  const files = await readPackageFiles(resolve(input));
  const descriptor = describeSolutionPackage(files);
  return { manifestDigest: descriptor.manifestDigest };
}

async function publishCommand(rawArgs: string[]): Promise<PublishResult> {
  const { positionals, flags } = parseArgs(rawArgs);
  const input = positionals[0];
  if (!input) throw new Error("package_directory_required");
  const outDir = stringFlag(flags, "--out") ?? ".";
  const keyPath = stringFlag(flags, "--key") ?? defaultDevSigningKeyPath();
  const result = await packSolution({
    sourceDir: resolve(input),
    outDir: resolve(outDir),
    privateKeyPemPath: resolve(keyPath),
    keyId: stringFlag(flags, "--key-id") ?? "weflow-dev",
  });
  const output: PublishResult = {
    tgzPath: result.tgzPath,
    solutionId: result.descriptor.manifest.metadata.id,
    version: result.descriptor.manifest.metadata.version,
    manifestDigest: result.descriptor.manifestDigest,
  };
  const registryUrl =
    stringFlag(flags, "--registry") ?? process.env.WEFLOW_SOLUTION_REGISTRY_URL;
  if (registryUrl) {
    const config = await loadCliConfig();
    const storedRegistry = config.registry;
    const storedToken =
      storedRegistry !== undefined && storedRegistry.url === registryUrl
        ? storedRegistry.token
        : undefined;
    output.registry = await publishSolutionTarball(
      registryUrl,
      result.tgzPath,
      {
        token:
          stringFlag(flags, "--registry-token") ??
          storedToken ??
          process.env.WEFLOW_SOLUTION_REGISTRY_TOKEN,
      },
    );
  }
  return output;
}

function looksLikePath(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    value.endsWith(".tgz") ||
    value.startsWith(".")
  );
}

async function installCommand(rawArgs: string[]): Promise<InstallResult> {
  const { positionals, flags } = parseArgs(rawArgs);
  const input = positionals[0];
  if (!input) throw new Error("package_directory_required");
  if (!looksLikePath(input)) {
    // Registry reference form: install <solutionId> [--registry <url>] [--version v]
    const { url: registryUrl, token: registryToken } =
      await resolveRegistryContext(flags);
    const registryOptions =
      registryToken !== undefined ? { token: registryToken } : {};
    let version = stringFlag(flags, "--version");
    if (registryUrl && !version) {
      version = (
        await fetchRegistryVersions(registryUrl, input, registryOptions)
      ).at(-1);
      if (!version) throw new Error(`registry_no_versions:${input}`);
    }
    if (!registryUrl || !version) {
      throw Object.assign(new Error(`registry_url_required:${input}`), {
        hint: "Pass --registry <url>, run `registry login`, or set WEFLOW_SOLUTION_REGISTRY_URL.",
      });
    }
    const { mkdtemp } = await import("node:fs/promises");
    const staging = await mkdtemp(join(tmpdir(), "weflow-registry-install-"));
    try {
      const { tgzPath } = await downloadSolutionTarball(
        registryUrl,
        input,
        version,
        staging,
        registryOptions,
      );
      const result = await installWithTrustFlag(flags, tgzPath);
      return { ...result, source: `registry:${registryUrl}` };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const result = await installWithTrustFlag(flags, input);
  return { ...result, activated: false };
}

async function installWithTrustFlag(
  flags: Record<string, string | true>,
  packagePath: string,
): Promise<InstallResult> {
  const trustedKeyFlag = stringFlag(flags, "--trusted-key");
  const trustedPublicKeyPem = trustedKeyFlag
    ? await readFile(resolve(trustedKeyFlag), "utf8")
    : undefined;
  const result = await installSolutionPackage(resolve(packagePath), {
    mode: "development",
    ...(trustedPublicKeyPem !== undefined ? { trustedPublicKeyPem } : {}),
  });
  return result;
}

async function activateCommand(rawArgs: string[]): Promise<ActivateResult> {
  const { positionals } = parseArgs(rawArgs);
  const id = positionals[0];
  if (!id) throw new Error("solution_id_required");
  let version = positionals[1];
  if (!version) {
    const installed = await listInstalledVersions(id);
    version = installed[installed.length - 1];
    if (!version) throw new Error(`solution_not_installed:${id}`);
  }
  await activateSolution(id, version);
  return { solutionId: id, activeVersion: version };
}

async function updateCommand(rawArgs: string[]): Promise<UpdateResult> {
  const { positionals, flags } = parseArgs(rawArgs);
  const id = positionals[0];
  if (!id) throw new Error("solution_id_required");
  const strategyFlag = stringFlag(flags, "--strategy") ?? "manual";
  if (!isSolutionUpdateStrategy(strategyFlag)) {
    throw new Error(
      `invalid_update_strategy:${strategyFlag}:expected ${UPDATE_STRATEGIES.join("|")}`,
    );
  }
  const explicitVersion = stringFlag(flags, "--version");
  let registryUrl =
    stringFlag(flags, "--registry") ?? process.env.WEFLOW_SOLUTION_REGISTRY_URL;
  let registryToken: string | undefined;
  if (registryUrl) {
    const context = await resolveRegistryContext(flags);
    registryUrl = context.url;
    registryToken = context.token;
  }
  const registryOptions =
    registryToken !== undefined ? { token: registryToken } : {};
  return updateSolutionInStore({
    solutionId: id,
    strategy: strategyFlag,
    ...(explicitVersion !== undefined ? { explicitVersion } : {}),
    ...(registryUrl
      ? {
          extraCandidates: await fetchRegistryVersions(
            registryUrl,
            id,
            registryOptions,
          ),
          ensureCandidate: async (targetVersion: string) => {
            const { mkdtemp } = await import("node:fs/promises");
            const staging = await mkdtemp(
              join(tmpdir(), "weflow-registry-update-"),
            );
            try {
              const { tgzPath } = await downloadSolutionTarball(
                registryUrl,
                id,
                targetVersion,
                staging,
                registryOptions,
              );
              await installSolutionPackage(tgzPath, { mode: "development" });
            } finally {
              await rm(staging, { recursive: true, force: true });
            }
          },
        }
      : {}),
  });
}

async function rollbackCommand(rawArgs: string[]): Promise<RollbackResult> {
  const { positionals, flags } = parseArgs(rawArgs);
  const id = positionals[0];
  if (!id) throw new Error("solution_id_required");
  const to = stringFlag(flags, "--to");
  if (to) {
    return rollbackSolutionTo({
      solutionId: id,
      version: to,
    });
  }
  return rollbackSolution(id);
}

async function listCommand(rawArgs: string[]): Promise<ListResult> {
  const { positionals } = parseArgs(rawArgs);
  const id = positionals[0];
  if (id) {
    return {
      solutionId: id,
      installedVersions: await listInstalledVersions(id),
      activeVersion: await readActiveVersion(id),
    };
  }
  if (!(await existsInStore("."))) return { solutions: [] };
  const solutions: SolutionListRow[] = [];
  for (const solutionId of await storeSolutions()) {
    solutions.push({
      solutionId,
      installedVersions: await listInstalledVersions(solutionId),
      activeVersion: await readActiveVersion(solutionId),
    });
  }
  return { solutions };
}

async function readPackageFiles(
  directory: string,
): Promise<SolutionPackageFiles> {
  const [manifestText, lockText, signatureText] = await Promise.all([
    readFile(resolve(directory, "solution.manifest.yaml"), "utf8").catch(() =>
      readFile(resolve(directory, "solution.manifest.json"), "utf8"),
    ),
    readFile(resolve(directory, "solution.lock.json"), "utf8"),
    readFile(resolve(directory, "signature.json"), "utf8"),
  ]);
  // JSON is a strict subset of YAML and is the only format accepted until the
  // dedicated YAML adapter is added. Never guess at a permissive YAML parse.
  const manifestTextTrimmed = manifestText.trim();
  if (!manifestTextTrimmed.startsWith("{"))
    throw new Error("yaml_adapter_required");
  return {
    manifest: JSON.parse(manifestTextTrimmed) as unknown,
    lock: JSON.parse(lockText) as unknown,
    signature: JSON.parse(signatureText) as unknown,
  };
}

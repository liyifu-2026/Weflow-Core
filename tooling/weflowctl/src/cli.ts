#!/usr/bin/env node
/**
 * Weflow CLI entry point.
 *
 * Responsibilities are deliberately narrow:
 *   1. parse global flags (--json / --quiet / --help / --version)
 *   2. dispatch to the command layer (tooling/weflowctl-*.ts)
 *   3. render the structured result through a CliOutput implementation
 *   4. set the process exit code
 *
 * No command logic lives here; see src/cli-output.ts for the rendering
 * contract and src/cli-errors.ts for the error code registry.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCliOutput, renderCommandResult } from "./cli-output.js";
import { runSolutionCommand, SOLUTION_USAGE } from "./weflowctl-solution.js";
import { runCompletionCommand, runConfigCommand } from "./weflowctl-config.js";

/**
 * Resolve the CLI's own version. Works from source (`src/../package.json`)
 * and from the mirrored build output (`dist/tooling/weflowctl/src/`).
 */
async function readCliVersion(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(await readFile(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "weflowctl") return pkg.version ?? "0.0.0";
      } catch {
        // fall through to the next parent
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

const argv = process.argv.slice(2);
const jsonMode = argv.includes("--json");
const quietMode = argv.includes("--quiet");
const domain = argv.find((item) => !item.startsWith("--"));

function topLevelUsage(): string {
  return [
    "Weflow CLI",
    "",
    "Usage: weflowctl <domain> <command> [args] [flags]",
    "",
    "Domains:",
    "  solution     Solution package management",
    "               publish / install / activate / update / rollback",
    "               key / registry / info / search / versions / history",
    "               doctor / inspect / export / import / auto-update / list",
    "  config       Read and write local CLI configuration",
    "  completion   Generate shell completion scripts (bash/zsh/powershell)",
    "",
    "Flags:",
    "  --json     Structured output for scripts",
    "  --quiet    Errors only",
    "  --help     Show help for a domain or command",
    "  --version  Print version",
    "",
  ].join("\n");
}

if (argv.includes("--version")) {
  console.log(await readCliVersion());
  process.exitCode = 0;
} else if (argv.length === 0 || argv.every((item) => item.startsWith("--"))) {
  const output = createCliOutput({ json: jsonMode, quiet: quietMode });
  output.info(topLevelUsage());
  process.exitCode = 0;
} else if (
  domain !== "solution" &&
  domain !== "config" &&
  domain !== "completion"
) {
  const output = createCliOutput({ json: jsonMode, quiet: quietMode });
  output.error({
    code: "unknown_cli_domain",
    message: `unknown domain: ${domain ?? "(none)"}`,
    hint: "Run `weflowctl --help` to list domains.",
  });
  process.exitCode = 2;
} else {
  const output = createCliOutput({ json: jsonMode, quiet: quietMode });
  const rest = argv.filter((item) => item !== "--json" && item !== "--quiet");
  const commandArgs = rest.slice(1);
  const commandName = commandArgs.find((item) => !item.startsWith("--")) ?? "";

  if (domain === "solution") {
    if (commandArgs.length === 0) {
      output.info(SOLUTION_USAGE);
      process.exitCode = 0;
    } else {
      const result = await runSolutionCommand(commandArgs);
      renderCommandResult(commandName, result, output, { json: jsonMode });
      if (!result.ok) process.exitCode = 1;
    }
  } else if (domain === "config") {
    if (commandArgs.length === 0) {
      output.error({
        code: "usage_error",
        message: "config requires a subcommand: get | set | list",
      });
      process.exitCode = 2;
    } else {
      const result = await runConfigCommand(commandArgs);
      if (commandName === "list" && result.ok) {
        const rows = (
          result.data as { values: Array<{ key: string; value: unknown }> }
        ).values.map((row) => ({ key: row.key, value: row.value ?? "-" }));
        if (jsonMode) output.json(result.data);
        else output.table(rows);
      } else {
        renderCommandResult(commandName, result, output, { json: jsonMode });
      }
      if (!result.ok) process.exitCode = 1;
    }
  } else {
    // completion <shell>: emit the script verbatim (never JSON-wrapped).
    const result = runCompletionCommand(commandArgs);
    if (result.ok) {
      console.log(String(result.data.script));
      process.exitCode = 0;
    } else {
      output.error({ message: result.error });
      process.exitCode = 1;
    }
  }
}

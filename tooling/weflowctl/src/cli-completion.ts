/**
 * Shell completion script generation (bash / zsh / PowerShell).
 *
 * Zero-dependency templates: subcommand lists are derived from the same
 * command registry the CLI uses, so completions stay in sync.
 */

const SOLUTION_COMMANDS = [
  "keygen",
  "key",
  "registry",
  "info",
  "search",
  "versions",
  "history",
  "verify",
  "digest",
  "publish",
  "install",
  "activate",
  "update",
  "rollback",
  "disable",
  "uninstall",
  "prune",
  "list",
] as const;

export function bashCompletion(): string {
  // Literal dollar sign for bash variables inside a JS template literal.
  const D = "$";
  return `# weflowctl bash completion
_weflowctl_completions() {
  local cur="${D}{COMP_WORDS[COMP_CWORD]}"
  local prev="${D}{COMP_WORDS[COMP_CWORD-1]}"
  local domains="solution"
  if [ "${D}COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${D}domains --help --version --json --quiet" -- "${D}cur") )
    return 0
  fi
  case "${D}prev" in
    solution)
      COMPREPLY=( $(compgen -W "${SOLUTION_COMMANDS.join(" ")}" -- "${D}cur") )
      return 0
      ;;
    key)
      COMPREPLY=( $(compgen -W "list import export" -- "${D}cur") )
      return 0
      ;;
    registry)
      COMPREPLY=( $(compgen -W "login logout status" -- "${D}cur") )
      return 0
      ;;
    update)
      COMPREPLY=( $(compgen -W "--strategy --version --registry" -- "${D}cur") )
      return 0
      ;;
    rollback)
      COMPREPLY=( $(compgen -W "--to" -- "${D}cur") )
      return 0
      ;;
    prune)
      COMPREPLY=( $(compgen -W "--keep" -- "${D}cur") )
      return 0
      ;;
  esac
  COMPREPLY=( $(compgen -W "--help --json" -- "${D}cur") )
}
complete -F _weflowctl_completions weflowctl
`;
}

export function zshCompletion(): string {
  return `#compdef weflowctl
# weflowctl zsh completion
_weflowctl() {
  local -a domains
  domains=(solution)
  _arguments -C \\
    '1:domain:($domains)' \\
    '*::command:->args'
  case $state in
    args)
      case $words[1] in
        solution)
          local -a cmds
          cmds=(${SOLUTION_COMMANDS.map((c) => `'${c}'`).join(" ")})
          _describe "command" cmds
          ;;
      esac
      ;;
  esac
}
_weflowctl "$@"
`;
}

export function powershellCompletion(): string {
  const commandList = SOLUTION_COMMANDS.join("|");
  return `# weflowctl PowerShell completion
Register-ArgumentCompleter -Native -CommandName weflowctl -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = $commandAst.ToString() -split '\\s+'
  $sub = $tokens[1]
  switch ($sub) {
    'solution' {
      if ($tokens.Count -le 2) {
        '${commandList}'.Split('|') | Where-Object { $_ -like "$wordToComplete*" } |
          ForEach-Object { [System.Management.Automation.CompletionResult]::new($_) }
      }
    }
    default {
      'solution' | Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object { [System.Management.Automation.CompletionResult]::new($_) }
    }
  }
}
`;
}

export function completionFor(shell: string): string {
  switch (shell) {
    case "bash":
      return bashCompletion();
    case "zsh":
      return zshCompletion();
    case "powershell":
    case "pwsh":
      return powershellCompletion();
    default:
      throw new Error(`unknown_shell:${shell}:expected bash|zsh|powershell`);
  }
}

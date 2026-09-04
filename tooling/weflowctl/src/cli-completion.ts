/**
 * Shell completion script generation (bash / zsh / PowerShell).
 *
 * Zero-dependency templates. R4：新增 service 域（Windows 服务管理）。
 */

const DEV_COMMANDS = ["doctor", "up", "down"] as const;
const SERVICE_COMMANDS = [
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
  "status",
] as const;
const CONFIG_COMMANDS = ["get", "set", "list"] as const;

export function bashCompletion(): string {
  // Literal dollar sign for bash variables inside a JS template literal.
  const D = "$";
  return `# weflowctl bash completion
_weflowctl_completions() {
  local cur="${D}{COMP_WORDS[COMP_CWORD]}"
  local domains="dev service config completion"
  if [ "${D}COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${D}domains --help --version --json --quiet" -- "${D}cur") )
    return 0
  fi
  case "${D}prev" in
    dev)
      COMPREPLY=( $(compgen -W "${DEV_COMMANDS.join(" ")}" -- "${D}cur") )
      return 0
      ;;
    service)
      COMPREPLY=( $(compgen -W "${SERVICE_COMMANDS.join(" ")}" -- "${D}cur") )
      return 0
      ;;
    config)
      COMPREPLY=( $(compgen -W "${CONFIG_COMMANDS.join(" ")}" -- "${D}cur") )
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
  domains=(dev service config completion)
  _arguments -C \\
    '1:domain:($domains)' \\
    '*::command:->args'
  case $state in
    args)
      case $words[1] in
        dev)
          local -a cmds
          cmds=(${DEV_COMMANDS.map((c) => `'${c}'`).join(" ")})
          _describe "command" cmds
          ;;
        service)
          cmds=(${SERVICE_COMMANDS.map((c) => `'${c}'`).join(" ")})
          _describe "command" cmds
          ;;
        config)
          cmds=(${CONFIG_COMMANDS.map((c) => `'${c}'`).join(" ")})
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
  const devList = DEV_COMMANDS.join("|");
  const serviceList = SERVICE_COMMANDS.join("|");
  const configList = CONFIG_COMMANDS.join("|");
  return `# weflowctl PowerShell completion
Register-ArgumentCompleter -Native -CommandName weflowctl -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = $commandAst.ToString() -split '\\s+'
  $sub = $tokens[1]
  switch ($sub) {
    'dev' {
      if ($tokens.Count -le 2) {
        '${devList}'.Split('|') | Where-Object { $_ -like "$wordToComplete*" } |
          ForEach-Object { [System.Management.Automation.CompletionResult]::new($_) }
      }
    }
    'service' {
      if ($tokens.Count -le 2) {
        '${serviceList}'.Split('|') | Where-Object { $_ -like "$wordToComplete*" } |
          ForEach-Object { [System.Management.Automation.CompletionResult]::new($_) }
      }
    }
    'config' {
      if ($tokens.Count -le 2) {
        '${configList}'.Split('|') | Where-Object { $_ -like "$wordToComplete*" } |
          ForEach-Object { [System.Management.Automation.CompletionResult]::new($_) }
      }
    }
    default {
      'dev service config completion' | Where-Object { $_ -like "$wordToComplete*" } |
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

# Starts the full local Weflow stack from core/.env:
#   1. Channel Host (detached)
#   2. Core API (detached)
# Run with -Stop to stop both.
param(
  [switch]$Stop
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$core = Join-Path $root "core"
$coreEnv = Join-Path $core ".env"
$logDir = Join-Path $core ".data\logs"
$channelRuntime = Join-Path $root "runtimes\channel-host-wechat"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Load-Env {
  foreach ($line in (Get-Content $coreEnv)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      [Environment]::SetEnvironmentVariable(
        $matches[1],
        $matches[2].Trim().Trim('"').Trim("'"),
        "Process"
      )
    }
  }
}

function Stop-FromPid([string]$name, [string]$pidFile) {
  if (Test-Path $pidFile) {
    $old = [int](Get-Content $pidFile)
    Stop-Process -Id $old -Force -ErrorAction SilentlyContinue
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Write-Host "$name stopped (was PID=$old)"
  }
}

if ($Stop) {
  Load-Env
  Stop-FromPid "Channel Host" (Join-Path $logDir "channel-host.pid")
  # uv may spawn a child python that owns the listener; kill it by port too.
  $listener = Get-NetTCPConnection -LocalPort 43123 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    Write-Host "Channel Host listener stopped (PID=$($listener.OwningProcess))"
  }
  Stop-FromPid "Core" (Join-Path $logDir "core.pid")
  return
}

Load-Env

if (-not $env:CHANNEL_HOST_TOKEN) { throw "CHANNEL_HOST_TOKEN is not set in $coreEnv" }
if (-not $env:MODEL_API_KEY) { throw "MODEL_API_KEY is not set in $coreEnv" }
if (-not $env:WEKNORA_API_KEY) { throw "WEKNORA_API_KEY is not set in $coreEnv" }

# 1) Channel Host
$python = Join-Path $channelRuntime ".venv\Scripts\python.exe"
if (Test-Path (Join-Path $logDir "channel-host.pid")) {
  Write-Host "Channel Host already running (pid file exists)"
} else {
  $ch = Start-Process -FilePath $python -ArgumentList @("-m", "channel_host.main") `
    -WorkingDirectory $channelRuntime `
    -RedirectStandardOutput (Join-Path $logDir "channel-host.out.log") `
    -RedirectStandardError (Join-Path $logDir "channel-host.err.log") `
    -WindowStyle Hidden -PassThru
  Set-Content (Join-Path $logDir "channel-host.pid") $ch.Id
  Write-Host "Channel Host started: PID=$($ch.Id)"
}

# 2) Core API
$node = "C:\Program Files\nodejs\node.exe"
$tsxDir = Get-ChildItem (Join-Path $core "node_modules\.pnpm") -Directory -Filter "tsx@*" |
  Select-Object -First 1 -ExpandProperty FullName
$preflight = Join-Path $tsxDir "node_modules\tsx\dist\preflight.cjs"
$loader = Join-Path $tsxDir "node_modules\tsx\dist\loader.mjs"
$loaderUrl = "file:///" + ($loader -replace "\\", "/")

if (Test-Path (Join-Path $logDir "core.pid")) {
  Write-Host "Core already running (pid file exists)"
} else {
  $coreArgs = @("--require", $preflight, "--import", $loaderUrl, "apps/api/main.ts")
  $cp = Start-Process -FilePath $node -ArgumentList $coreArgs `
    -WorkingDirectory $core `
    -RedirectStandardOutput (Join-Path $logDir "core.out.log") `
    -RedirectStandardError (Join-Path $logDir "core.err.log") `
    -WindowStyle Hidden -PassThru
  Set-Content (Join-Path $logDir "core.pid") $cp.Id
  Write-Host "Core started: PID=$($cp.Id)"
}

Start-Sleep -Seconds 2
Write-Host "Done. Logs: $logDir"

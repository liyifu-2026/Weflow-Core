# Runs the Weflow Channel Host (wechat adapter) using secrets from core/.env.
param(
  [switch]$Detached
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$coreEnv = Resolve-Path (Join-Path $here "../../core/.env")

# Load core/.env into this process (without printing values).
foreach ($line in (Get-Content $coreEnv)) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
    [Environment]::SetEnvironmentVariable(
      $matches[1],
      $matches[2].Trim().Trim('"').Trim("'"),
      "Process"
    )
  }
}

if (-not $env:CHANNEL_HOST_TOKEN) {
  throw "CHANNEL_HOST_TOKEN is not set in $coreEnv"
}

$python = Join-Path $here ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
  throw ".venv not found; run: uv sync --frozen --no-cache"
}

if ($Detached) {
  $logDir = Join-Path $here ".data"
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  $p = Start-Process -FilePath $python -ArgumentList @("-m", "channel_host.main") `
    -WorkingDirectory $here `
    -RedirectStandardOutput (Join-Path $logDir "channel-host.out.log") `
    -RedirectStandardError (Join-Path $logDir "channel-host.err.log") `
    -WindowStyle Hidden -PassThru
  Write-Host "Channel Host started: PID=$($p.Id)"
  return $p.Id
}

& $python -m channel_host.main

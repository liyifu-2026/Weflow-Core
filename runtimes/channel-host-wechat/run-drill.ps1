# Drill 专用 Channel Host 启动器（平行栈，绝不触碰真实数据）：
# - 独立 event store：.data/channel-host-drill.sqlite3（空库 → 触发自动 backfill）
# - 独立端口 43124、独立媒体暂存目录
# - 仅读取真实微信 DB（只读），不写任何真实通道状态
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$coreEnv = Resolve-Path (Join-Path $here "../../core/.env")

foreach ($line in (Get-Content $coreEnv)) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim().Trim('"').Trim("'"), "Process")
  }
}

# Drill 覆盖项（在真实 .env 之后应用）
$env:CHANNEL_HOST_EVENT_STORE = Join-Path $here ".data\channel-host-drill.sqlite3"
$env:CHANNEL_HOST_MEDIA_STAGING = Join-Path $here ".data\channel-host-media-drill"
$env:CHANNEL_HOST_PORT = "43124"
$env:CHANNEL_HOST_BIND = "127.0.0.1"
# 演练参数：全量回溯（0=不限时间），私聊，批 200 / 间隔 500ms
$env:WECHAT_BACKFILL_SINCE_DAYS = "0"
$env:WECHAT_BACKFILL_INCLUDE_GROUPS = "0"
$env:WECHAT_BACKFILL_BATCH_SIZE = "200"
$env:WECHAT_BACKFILL_BATCH_DELAY_MS = "500"

$python = Join-Path $here ".venv\Scripts\python.exe"
$logDir = Join-Path $here ".data"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$p = Start-Process -FilePath $python -ArgumentList @("-u", "-m", "channel_host.main") `
  -WorkingDirectory $here `
  -RedirectStandardOutput (Join-Path $logDir "channel-host-drill.out.log") `
  -RedirectStandardError (Join-Path $logDir "channel-host-drill.err.log") `
  -WindowStyle Hidden -PassThru
Write-Host "Drill Channel Host started: PID=$($p.Id)"

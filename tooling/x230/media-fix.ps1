# X230 media fix bootstrap (2026-09-16, commit eb05a4a).
# Runs INSIDE the interactive session via RDP (Win+R bootstrap command does:
#   cd C:\We\weflow\weflow; git pull origin main; iex(gc .\tooling\x230\media-fix.ps1 -Raw)
# ).
# Steps: restart channel host with cfgDword image-key fix -> requeue failed
# image media_assets -> snapshot status -> publish log via support-web dist
# (fetchable at https://web.leaif.com/media-fix.log) -> hand the session back
# to the physical console (tscon) so WeChat UIA keeps working unattended.
#
# ASCII only: PowerShell 5.1 parses BOM-less .ps1 as ANSI.

$ErrorActionPreference = 'Continue'

$repoDir = 'C:\We\weflow\weflow'
$logPath = 'C:\We\logs\media-fix.log'
$webDist = Join-Path $repoDir 'solutions\customer-support\apps\support-web\dist'
$psqlExe = 'C:\We\tools\pgsql\bin\psql.exe'

if (-not (Test-Path 'C:\We\logs')) { New-Item -ItemType Directory -Path 'C:\We\logs' | Out-Null }
"=== media-fix $(Get-Date -Format s) ===" | Out-File $logPath -Encoding utf8
function Log([string]$m) {
  $m | Out-File $logPath -Append -Encoding utf8
  Write-Host $m
}

Log ("whoami: " + (whoami))
Log ("host: " + $env:COMPUTERNAME)

# --- 1. git state (pull is done by the bootstrap command; verify here) ---
Set-Location $repoDir
git config --global --add safe.directory $repoDir.Replace('\', '/') 2>$null
Log ("git head: " + ((git log --oneline -1 2>&1) | Out-String).Trim())
$st = ((git status --porcelain 2>&1) | Out-String).Trim()
if ($st) { Log ("git dirty files: " + $st) }
if (-not ((git log --oneline -1 2>&1) -join '').Contains('eb05a4a')) {
  Log 'expected commit eb05a4a not at HEAD; attempting pull'
  git pull origin main 2>&1 | ForEach-Object { Log ("pull: " + $_) }
}
$fixed = (Select-String -Path (Join-Path $repoDir 'runtimes\channel-host-wechat\wechatauto\media.py') -Pattern '_derive_cfg_key\(refresh_dword' -SimpleMatch:$false -Quiet)
Log ("media.py has cfg fix: " + $fixed)
if (-not $fixed) { Log 'FATAL: fix not present; aborting restart'; Copy-Item $logPath (Join-Path $webDist 'media-fix.log') -Force; exit 1 }

# --- 2. restart channel host with new code ---
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'channel_host' } |
  ForEach-Object {
    Log ("kill python pid " + $_.ProcessId + ": " + $_.CommandLine)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction Continue
  }
Start-Sleep -Seconds 2
$out = schtasks /run /tn "Weflow ChannelHost" 2>&1 | Out-String
Log ("schtasks run: " + $out.Trim())
Start-Sleep -Seconds 10
$tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port 43123 -WarningAction SilentlyContinue
Log ("channel host 43123 listening: " + $tcp.TcpTestSucceeded)
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:43123/healthz' -TimeoutSec 5
  Log ("healthz: HTTP " + $r.StatusCode)
} catch {
  $code = $null
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  # 401 is the expected healthy answer (bearer token required)
  Log ("healthz: HTTP " + $code + " (401 = alive)")
}

# --- 3. requeue failed inbound images so core re-syncs them from the host ---
$dbLine = (Get-Content (Join-Path $repoDir 'core\.env') | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1)
if ($dbLine -and $psqlExe) {
  $dbUrl = ($dbLine -replace '^DATABASE_URL=', '').Trim()
  if ($dbUrl -match '://([^:/@]+):([^@]+)@') { $env:PGPASSWORD = $Matches[2] }
  $sql = "UPDATE media.assets SET status='queued', attempt=0, next_attempt_at=now(), error_code=NULL WHERE kind='image' AND status='failed' AND source_media_ref IS NOT NULL;"
  $r1 = (& $psqlExe $dbUrl -c $sql 2>&1) | Out-String
  Log ("requeue failed images: " + $r1.Trim())
  Start-Sleep -Seconds 25
  $r2 = (& $psqlExe $dbUrl -c "SELECT status, count(*) FROM media.assets WHERE kind='image' GROUP BY 1 ORDER BY 1;" 2>&1) | Out-String
  Log ("image media status after 25s:`n" + $r2.Trim())
} else {
  Log 'requeue skipped: DATABASE_URL or psql not found'
}

# --- 4. publish the log through the public static dist ---
try {
  Copy-Item $logPath (Join-Path $webDist 'media-fix.log') -Force
  Log 'log published to dist/media-fix.log'
} catch {
  Log ('publish failed: ' + $_.Exception.Message)
}

# --- 5. hand the session back to the physical console ---
$qs = @(query session) | Select-Object -Skip 1
foreach ($l in $qs) { Log ("sess: " + $l) }
$rdpRow = $qs | Where-Object { $_ -match 'Active' -and $_ -match 'rdp' } | Select-Object -First 1
$discConsole = $qs | Where-Object { $_ -match 'Disc' -and $_ -match 'console' } | Select-Object -First 1
if ($rdpRow) {
  $rid = [int](($rdpRow.Trim() -split '\s+')[2])
  if ($discConsole) {
    # Another user's console session was displaced by this login: reconnect it
    # via a SYSTEM task, then log this RDP session off.
    $cid = [int](($discConsole.Trim() -split '\s+')[2])
    schtasks /create /tn WeflowConsoleReconnect /tr ('cmd /c tscon ' + $cid + ' /dest:console') /sc once /st 23:59 /ru SYSTEM /f | Out-Null
    $run2 = schtasks /run /tn WeflowConsoleReconnect 2>&1 | Out-String
    Log ('reconnect console ' + $cid + ' via SYSTEM task: ' + $run2.Trim() + '; logging off rdp ' + $rid)
    logoff $rid
  } else {
    tscon $rid /dest:console
    Log ('tscon ' + $rid + ' -> console (same-user takeover restored)')
  }
} else {
  Log 'no active rdp session row found; leaving session state untouched'
}

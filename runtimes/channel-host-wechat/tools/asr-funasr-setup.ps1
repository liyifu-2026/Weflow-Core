# FunASR 本地 ASR 服务一键安装（SenseVoice，CPU 推理）
# 用法（工作区根目录执行）：
#   powershell -ExecutionPolicy Bypass -File weflow\runtimes\channel-host-wechat\tools\asr-funasr-setup.ps1
# 默认安装到 .\tools\asr-funasr（可用 -InstallDir 指定其他目录）。
# 装完启动：
#   tools\asr-funasr\.venv\Scripts\funasr-server.exe --host 127.0.0.1 --port 8000 --model sensevoice --device cpu
# 接线：设置中心「模型」注册 http://127.0.0.1:8000（协议 audio_transcriptions）绑定 asr 槽位。
# 详见工作区 docs/ops.md 第 5 节。依据：FunASR 官方 README「Deploy」节（2026-09 实查）。

param(
  [string]$InstallDir = (Join-Path (Get-Location) "tools\asr-funasr")
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$venv = Join-Path $InstallDir ".venv"
$pyExe = Join-Path $venv "Scripts\python.exe"

$haveUv = $null -ne (Get-Command uv -ErrorAction SilentlyContinue)

if (-not (Test-Path $pyExe)) {
  if ($haveUv) {
    uv venv $venv
  } else {
    python -m venv $venv
    # 兜底：部分机器 python -m venv 的 ensurepip 会失败，此时要求改装 uv
    & $pyExe -c "import pip" 2>$null
    if ($LASTEXITCODE -ne 0) {
      throw "python -m venv 缺 pip 且本机没有 uv；请先安装 uv（https://docs.astral.sh/uv/）后重跑本脚本。"
    }
  }
}

function Install-Pkgs {
  if ($haveUv) { uv pip install --python $pyExe @args }
  else { & $pyExe -m pip install @args }
}

# torch 装 CPU 版（避免拉到 CUDA 版白多几个 GB）
Install-Pkgs @("torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cpu")
Install-Pkgs @("funasr", "fastapi", "uvicorn[standard]", "python-multipart")

Write-Host ""
Write-Host "安装完成：$InstallDir"
Write-Host "启动（首次启动自动下载 SenseVoice 模型约 1GB）："
Write-Host "  $venv\Scripts\funasr-server.exe --host 127.0.0.1 --port 8000 --model sensevoice --device cpu"
Write-Host "自测（另开终端）："
Write-Host "  curl -F file=@sample.wav -F model=sensevoice http://127.0.0.1:8000/v1/audio/transcriptions"

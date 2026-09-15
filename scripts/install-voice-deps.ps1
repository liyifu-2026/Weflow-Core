# Installs the SILK decoder (silk-python) used by the Ingestion Worker's
# voice transcode pipeline into the channel-host venv.
#
# Scope note (2026-09-09): this script no longer manages ffmpeg. The encoder
# now ships at workspace-root tools/ffmpeg/ffmpeg.exe and is configured via
# core/.env VOICE_FFMPEG_PATH — no imageio-ffmpeg, no PATH guessing.
#
# Requirements:
#   - uv (https://docs.astral.sh/uv/) on PATH
#   - runtimes/channel-host-wechat/.venv already created (it is the venv that
#     ships the WeChat DB/media driver and also the SILK decoder)
#
# PyPI's "pysilk" 0.0.1 is an empty placeholder; "silk-python" is the real
# package providing the pysilk module. Never use the system Python.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$venvDir = Join-Path $repoRoot "runtimes\channel-host-wechat\.venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    throw "Channel Host venv not found: $venvPython"
}

Get-Command uv | Out-Null

Write-Host "Installing silk-python into $venvDir ..."
& uv pip install --python $venvPython silk-python
if ($LASTEXITCODE -ne 0) {
    throw "uv pip install failed"
}

& $venvPython -c "import pysilk; print('pysilk ok')"
if ($LASTEXITCODE -ne 0) {
    throw "pysilk import check failed"
}

Write-Host ""
Write-Host "Voice SILK decoder ready."
Write-Host "Make sure core/.env contains (adjust to your checkout):"
Write-Host "  VOICE_PYTHON_PATH=$($venvPython -replace '\\', '/')"
Write-Host "  VOICE_FFMPEG_PATH=<workspace-root>\tools\ffmpeg\ffmpeg.exe"
Write-Host ""
Write-Host "Then restart the ingestion worker (weflowctl dev restart / up) so"
Write-Host "the injected environment is picked up."

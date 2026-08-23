# Installs the SILK -> PCM -> MP3 voice toolchain used by the Ingestion Worker.
#
# Requirements:
#   - uv (https://docs.astral.sh/uv/) on PATH
#   - runtimes/channel-host-wechat/.venv already created (it is the venv that
#     ships the WeChat DB/media driver and now also the SILK decoder)
#
# After running this script, start the Ingestion Worker with:
#   $env:PYTHON_PATH = '<venv>\Scripts\python.exe'
#   $env:FFMPEG_PATH = '<venv>\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe'
#
# The script prints those two values so you can copy them into your dev
# environment or a wrapper script.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$venvDir = Join-Path $repoRoot "runtimes\channel-host-wechat\.venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    throw "Channel Host venv not found: $venvPython"
}

Get-Command uv | Out-Null

Write-Host "Installing silk-python and imageio-ffmpeg into $venvDir ..."
& uv pip install --python $venvPython silk-python imageio-ffmpeg

$ffmpegPath = & $venvPython -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
if ($LASTEXITCODE -ne 0 -or -not $ffmpegPath) {
    throw "Could not resolve imageio_ffmpeg executable path"
}

Write-Host ""
Write-Host "Voice dependencies ready."
Write-Host "Start the Ingestion Worker with:"
Write-Host "  `$env:PYTHON_PATH = '$venvPython'"
Write-Host "  `$env:FFMPEG_PATH = '$ffmpegPath'"
Write-Host ""
Write-Host "Example:"
Write-Host "  `$env:PYTHON_PATH = '$venvPython'"
Write-Host "  `$env:FFMPEG_PATH = '$ffmpegPath'"
Write-Host "  pnpm --dir core dev:ingestion-worker"

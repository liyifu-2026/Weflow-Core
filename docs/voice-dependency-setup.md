# Voice SILK Toolchain Setup

Weflow's voice ASR path converts WeChat SILK to MP3 before sending it to the
MiMo ASR endpoint. The Ingestion Worker needs:

- `silk-python` — provides a real `pysilk.decode` implementation
- `imageio-ffmpeg` — provides a portable `ffmpeg.exe`

## One-click installer

```powershell
# from the repository root (weflow/)
powershell -ExecutionPolicy Bypass -File .\scripts\install-voice-deps.ps1
```

The script installs both packages into
`runtimes/channel-host-wechat/.venv` and prints the exact
`PYTHON_PATH` / `FFMPEG_PATH` values.

## Manual installation

```powershell
$venvPython = "C:\...\weflow\runtimes\channel-host-wechat\.venv\Scripts\python.exe"
uv pip install --python $venvPython silk-python imageio-ffmpeg
$ffmpegPath = & $venvPython -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
```

## Starting the Ingestion Worker

```powershell
$env:PYTHON_PATH = "C:\...\weflow\runtimes\channel-host-wechat\.venv\Scripts\python.exe"
$env:FFMPEG_PATH = "C:\...\weflow\runtimes\channel-host-wechat\.venv\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
pnpm --dir core dev:ingestion-worker
```

If either tool is missing the worker falls back to `transcode_unavailable` and
the message is handled by the degraded-turn path instead of silently dropping.

## Verification

```powershell
$env:PYTHON_PATH = "C:\...\weflow\runtimes\channel-host-wechat\.venv\Scripts\python.exe"
& $env:PYTHON_PATH -c "import pysilk; print('pysilk ok')"
& $env:PYTHON_PATH -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
```

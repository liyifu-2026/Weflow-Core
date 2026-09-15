# Voice SILK Toolchain Setup

Weflow's voice ASR path converts WeChat SILK to MP3 before sending it to the
ASR endpoint. The Ingestion Worker spawns two executables per voice job:

- `python` + `pysilk` — decodes SILK to raw PCM (s16le)
- `ffmpeg` — encodes PCM to MP3 (`libmp3lame`)

## Where the paths come from

The worker reads **only** these two settings (no hardcoded local paths — the
old MarukoToolbox / user-directory fallbacks were removed on 2026-09-09):

- `VOICE_PYTHON_PATH` — python.exe with `pysilk` importable
- `VOICE_FFMPEG_PATH` — ffmpeg.exe with `libmp3lame`

Both live in `core/.env` and are injected into child processes by
`weflowctl dev up`. When starting the worker manually, pass them yourself:

```powershell
cd core
node --env-file=.env node_modules\.pnpm\tsx@4.20.3\node_modules\tsx\dist\cli.mjs apps/ingestion-worker/main.ts
```

Unset values fall back to `PATH` resolution; a missing executable raises
`transcode_unavailable` and the message goes through the honest degraded-turn
path instead of being dropped silently.

## Current machine layout

| piece | location |
|-------|----------|
| ffmpeg 9.0.1 (gyan essentials build, has libmp3lame) | `tools/ffmpeg/ffmpeg.exe` (workspace root) |
| python 3.11 + pysilk | `weflow/runtimes/channel-host-wechat/.venv` |

Note: PyPI's `pysilk` 0.0.1 is an empty placeholder — the real decoder comes
from the `silk-python` package (provides the `pysilk` module). Never point
`VOICE_PYTHON_PATH` at the system Python.

## (Re)installing silk-python into the venv

```powershell
# from the repository root (weflow/)
powershell -ExecutionPolicy Bypass -File .\scripts\install-voice-deps.ps1
```

or manually:

```powershell
$venvPython = "C:\...\weflow\runtimes\channel-host-wechat\.venv\Scripts\python.exe"
uv pip install --python $venvPython silk-python
```

Then make sure `core/.env` contains:

```
VOICE_PYTHON_PATH=C:/Users/12991/Desktop/We/weflow/runtimes/channel-host-wechat/.venv/Scripts/python.exe
VOICE_FFMPEG_PATH=C:\Users\12991\Desktop\We\tools\ffmpeg\ffmpeg.exe
```

Restart the worker afterwards — `weflowctl` injects `.env` only at process
start; a tsx-watch restart inherits the old environment.

## Verification

```powershell
& "C:\...\weflow\runtimes\channel-host-wechat\.venv\Scripts\python.exe" -c "import pysilk; print('pysilk ok')"
& "C:\...\tools\ffmpeg\ffmpeg.exe" -version
& "C:\...\tools\ffmpeg\ffmpeg.exe" -hide_banner -encoders 2>NUL | findstr libmp3lame
```

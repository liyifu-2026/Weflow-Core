"""Inbound media adapter for the local WeChat Channel Host."""

from __future__ import annotations

from dataclasses import dataclass
import mimetypes
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
from typing import Callable, Optional

from .event_store import EventStore


# 原图 UI 下载（WECHAT_MEDIA_ORIGINAL_VIA_UI=1）的后台结果缓存目录名
UI_ORIGINAL_DIR = "ui-original"


@dataclass(frozen=True)
class ChannelMediaReadResult:
    state: str
    path: Optional[str] = None
    mime_type: Optional[str] = None
    file_name: Optional[str] = None
    error_code: Optional[str] = None
    variant: str = "original"
    cleanup: Optional[Callable[[], None]] = None

    @classmethod
    def ready(
        cls,
        path: str,
        mime_type: str,
        file_name: Optional[str] = None,
        cleanup: Optional[Callable[[], None]] = None,
        variant: str = "original",
    ) -> "ChannelMediaReadResult":
        return cls(
            "ready",
            path=path,
            mime_type=mime_type,
            file_name=file_name,
            cleanup=cleanup,
            variant=variant,
        )

    @classmethod
    def pending(cls) -> "ChannelMediaReadResult":
        return cls("pending")

    @classmethod
    def not_found(cls) -> "ChannelMediaReadResult":
        return cls("not_found")

    @classmethod
    def failed(cls, error_code: str) -> "ChannelMediaReadResult":
        return cls("failed", error_code=error_code)


def create_media_resolver(
    event_store: EventStore,
    downloader,
    staging_root: str,
    emoji_capture: Optional[Callable[[str, int], Optional[str]]] = None,
    ui_original_enabled: bool = False,
) -> Callable[[str], ChannelMediaReadResult]:
    """Create a bounded, host-owned resolver around wechatauto media reading.

    图片请求路径绝不触发进程内存扫描：原图缺 AES 密钥时立即回退到免密钥
    的缩略图 ``_t.dat``；两者都不可用才返回 pending（Core 侧按既有退避
    策略重试后转 failed → 降级 Turn）。

    ``ui_original_enabled=True``（环境变量 ``WECHAT_MEDIA_ORIGINAL_VIA_UI=1``）：
    原图与缩略图都不可用/仅缩略图时，后台线程调用
    ``MediaDownloader.download_image_original``（UI 自动化点击微信图片触发
    官方下载原图），成功后缓存结果；下次请求直接命中缓存拿到原图。同一
    media_ref 至多尝试 2 次，避免反复抢占微信窗口。
    """
    root = Path(staging_root)
    root.mkdir(parents=True, exist_ok=True)
    ui_original = _UiOriginalTrigger(
        downloader, root, enabled=ui_original_enabled
    )

    def resolve(media_ref: str) -> ChannelMediaReadResult:
        source = event_store.find_media_source(media_ref)
        if source is None:
            return ChannelMediaReadResult.not_found()
        conversation_ref = source["conversationRef"]
        channel_message_id = source["channelMessageId"]
        kind = source.get("kind")
        if (
            not isinstance(conversation_ref, str)
            or not isinstance(channel_message_id, str)
            or not isinstance(kind, str)
        ):
            return ChannelMediaReadResult.failed("media_source_invalid")
        try:
            local_id = int(channel_message_id)
        except ValueError:
            return ChannelMediaReadResult.failed("media_source_invalid")

        request_dir = Path(tempfile.mkdtemp(prefix="media-", dir=root))
        if kind == "image":
            # 后台 UI 下载原图的历史成果：命中则直接以原图返回（不删缓存）
            cached = ui_original.cached_ready(media_ref)
            if cached is not None:
                _remove_directory(request_dir)
                return cached
            result = _resolve_image(
                downloader,
                conversation_ref,
                local_id,
                source,
                request_dir,
                root,
            )
            if result is not None:
                return result
            _remove_directory(request_dir)
            result = _resolve_thumbnail(downloader, conversation_ref, local_id, root)
            # 原图不可用（无论缩略图是否兜底成功）：后台尝试 UI 下载原图，
            # 成果入缓存，下一次请求即升级为原图。
            ui_original.maybe_trigger(media_ref, conversation_ref, local_id)
            return result

        if kind == "video":
            try:
                path = downloader.download_video(
                    conversation_ref,
                    local_id,
                    save_dir=str(request_dir),
                )
            except RuntimeError:
                _remove_directory(request_dir)
                return ChannelMediaReadResult.pending()
            except ValueError:
                _remove_directory(request_dir)
                return ChannelMediaReadResult.failed("media_unreadable")
            except OSError:
                _remove_directory(request_dir)
                return ChannelMediaReadResult.pending()
            except Exception:
                _remove_directory(request_dir)
                return ChannelMediaReadResult.failed("media_source_error")
            if not path or not os.path.isfile(path):
                _remove_directory(request_dir)
                return ChannelMediaReadResult.failed("video_not_found")
            return ChannelMediaReadResult.ready(
                path,
                "video/mp4",
                cleanup=lambda: _remove_directory(request_dir),
            )

        if kind == "voice":
            try:
                path = downloader.download_voice(
                    conversation_ref,
                    local_id,
                    save_dir=str(request_dir),
                )
            except RuntimeError:
                _remove_directory(request_dir)
                return ChannelMediaReadResult.pending()
            except ValueError:
                _remove_directory(request_dir)
                return ChannelMediaReadResult.failed("media_unreadable")
            except OSError:
                _remove_directory(request_dir)
                return ChannelMediaReadResult.pending()
            except Exception:
                _remove_directory(request_dir)
                return ChannelMediaReadResult.failed("media_source_error")
            if not path or not os.path.isfile(path):
                _remove_directory(request_dir)
                return ChannelMediaReadResult.pending()
            return ChannelMediaReadResult.ready(
                path,
                "audio/x-silk",
                cleanup=lambda: _remove_directory(request_dir),
            )

        if kind == "emotion":
            if emoji_capture is None:
                _remove_directory(request_dir)
                return ChannelMediaReadResult.failed("emoji_capture_unavailable")
            try:
                path = emoji_capture(conversation_ref, local_id)
            except Exception:
                path = None
            if not path or not os.path.isfile(path):
                _remove_directory(request_dir)
                return ChannelMediaReadResult.pending()
            mime_type = _image_mime_type(path)
            if mime_type is None:
                _remove_directory(request_dir)
                return ChannelMediaReadResult.failed("media_mime_unsupported")
            return ChannelMediaReadResult.ready(
                path,
                mime_type,
                cleanup=lambda: _remove_directory(request_dir),
            )

        try:
            path = downloader.download_file(
                conversation_ref,
                local_id,
                save_dir=str(request_dir),
            )
        except RuntimeError:
            _remove_directory(request_dir)
            return ChannelMediaReadResult.pending()
        except ValueError:
            _remove_directory(request_dir)
            return ChannelMediaReadResult.failed("media_unreadable")
        except OSError:
            _remove_directory(request_dir)
            return ChannelMediaReadResult.pending()
        except Exception:
            _remove_directory(request_dir)
            return ChannelMediaReadResult.failed("media_source_error")

        if not path or not os.path.isfile(path):
            _remove_directory(request_dir)
            return ChannelMediaReadResult.pending()
        mime_type = _file_mime_type(path)
        return ChannelMediaReadResult.ready(
            path,
            mime_type,
            file_name=_source_file_name(source, path),
            cleanup=lambda: _remove_directory(request_dir),
        )

    return resolve


class _UiOriginalTrigger:
    """后台 UI 下载原图触发器（带缓存与尝试上限）。

    - ``cached_ready``：历史成功的结果作为缓存原图直接返回（文件在
      ``<staging>/ui-original/``，持久保留，重启后依然命中）。
    - ``maybe_trigger``：同一线程内同一 media_ref 至多调度一次；全局并发
      至多 1（串行化，避免多次 UI 抢窗口）；每条 media_ref 最多尝试 2 次，
      超限后永久放弃。
    - UI 失败/超时绝不影响当次响应；错误码仅记录在内存，不污染协议。
    """

    _MAX_ATTEMPTS = 2

    def __init__(self, downloader, staging_root: Path, enabled: bool):
        self._downloader = downloader
        self._root = staging_root / UI_ORIGINAL_DIR
        self._enabled = enabled
        self._lock = threading.Lock()
        self._scheduled: set[str] = set()
        self._attempts: dict[str, int] = {}
        self._inflight = threading.Semaphore(1)

    def cached_ready(self, media_ref: str) -> Optional[ChannelMediaReadResult]:
        result_dir = self._root / _safe_dir_name(media_ref)
        for name in os.listdir(result_dir) if result_dir.is_dir() else ():
            path = result_dir / name
            mime = _image_mime_type(str(path))
            if path.is_file() and mime is not None:
                return ChannelMediaReadResult.ready(
                    str(path), mime, variant="original"
                )
        return None

    def maybe_trigger(
        self, media_ref: str, conversation_ref: str, local_id: int
    ) -> None:
        if not self._enabled:
            return
        with self._lock:
            if media_ref in self._scheduled:
                return
            attempts = self._attempts.get(media_ref, 0)
            if attempts >= self._MAX_ATTEMPTS:
                return
            self._scheduled.add(media_ref)
        thread = threading.Thread(
            target=self._run,
            args=(media_ref, conversation_ref, local_id),
            name=f"ui-original-{_safe_dir_name(media_ref)}",
            daemon=True,
        )
        thread.start()

    def _run(
        self, media_ref: str, conversation_ref: str, local_id: int
    ) -> None:
        with self._inflight:
            with self._lock:
                self._attempts[media_ref] = self._attempts.get(media_ref, 0) + 1
                self._scheduled.discard(media_ref)
            result_dir = self._root / _safe_dir_name(media_ref)
            result_dir.mkdir(parents=True, exist_ok=True)
            try:
                path = self._downloader.download_image_original(
                    conversation_ref,
                    local_id,
                    save_dir=str(result_dir),
                    timeout=45.0,
                )
            except Exception as error:
                print(f"[media-original] ui download failed: {type(error).__name__}: {error}")
                return
            if path and os.path.isfile(path) and _image_mime_type(path):
                print(f"[media-original] cached ui original for {media_ref}")
            else:
                # 没拿到可用文件：清掉空目录，避免 cached_ready 扫到垃圾
                shutil.rmtree(result_dir, ignore_errors=True)


def _safe_dir_name(media_ref: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", media_ref)[-120:]


def _resolve_image(
    downloader,
    conversation_ref: str,
    local_id: int,
    source: dict[str, object],
    request_dir: Path,
    staging_root: Path,
) -> Optional[ChannelMediaReadResult]:
    """原图解析；返回 None 表示需要走缩略图回退。"""
    try:
        path = downloader.download_image(
            conversation_ref,
            local_id,
            save_dir=str(request_dir),
            allow_key_scan=False,
        )
        if path and os.path.isfile(path):
            mime_type = _image_mime_type(path)
            if mime_type is not None:
                return ChannelMediaReadResult.ready(
                    path,
                    mime_type,
                    file_name=_source_file_name(source, path),
                    cleanup=lambda: _remove_directory(request_dir),
                )
            # 落盘但不是可显示图片（如 wxgf 容器）：尝试缩略图
            return None
    except RuntimeError:
        # AES 密钥缺失：立即回退缩略图，不做内存扫描、不阻塞
        return None
    except ValueError:
        _remove_directory(request_dir)
        return ChannelMediaReadResult.failed("media_unreadable")
    except OSError:
        _remove_directory(request_dir)
        return ChannelMediaReadResult.pending()
    except Exception:
        _remove_directory(request_dir)
        return ChannelMediaReadResult.failed("media_source_error")
    return None


def _resolve_thumbnail(
    downloader,
    conversation_ref: str,
    local_id: int,
    staging_root: Path,
) -> ChannelMediaReadResult:
    thumb_dir = Path(tempfile.mkdtemp(prefix="media-thumb-", dir=staging_root))
    try:
        thumb_path = downloader.download_image_thumbnail(
            conversation_ref,
            local_id,
            save_dir=str(thumb_dir),
        )
        if thumb_path and os.path.isfile(thumb_path):
            mime_type = _image_mime_type(thumb_path)
            if mime_type is not None:
                return ChannelMediaReadResult.ready(
                    thumb_path,
                    mime_type,
                    cleanup=lambda: _remove_directory(thumb_dir),
                    variant="thumbnail",
                )
    except Exception:
        pass
    _remove_directory(thumb_dir)
    return ChannelMediaReadResult.pending()


def _source_file_name(source: dict[str, object], path: str) -> str:
    name = source.get("fileName")
    return name if isinstance(name, str) else Path(path).name


def _image_mime_type(path: str) -> Optional[str]:
    guessed, _ = mimetypes.guess_type(path)
    if guessed in {"image/jpeg", "image/png", "image/gif"}:
        return guessed
    return None


def _file_mime_type(path: str) -> str:
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def _remove_directory(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)

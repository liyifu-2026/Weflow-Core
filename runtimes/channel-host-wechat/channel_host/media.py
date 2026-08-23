"""Inbound media adapter for the local WeChat Channel Host."""

from __future__ import annotations

from dataclasses import dataclass
import mimetypes
import os
from pathlib import Path
import shutil
import tempfile
from typing import Callable, Optional

from .event_store import EventStore


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
) -> Callable[[str], ChannelMediaReadResult]:
    """Create a bounded, host-owned resolver around wechatauto media reading.

    图片请求路径绝不触发进程内存扫描：原图缺 AES 密钥时立即回退到免密钥
    的缩略图 ``_t.dat``；两者都不可用才返回 pending（Core 侧按既有退避
    策略重试后转 failed → 降级 Turn）。
    """
    root = Path(staging_root)
    root.mkdir(parents=True, exist_ok=True)

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
            return _resolve_thumbnail(downloader, conversation_ref, local_id, root)

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

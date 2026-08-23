"""Background WeChat image AES key maintenance for the Channel Host.

启动时立即扫描一次，之后按固定周期补偿扫描；密钥只在状态跃迁时打日志，
任何日志/异常输出都不得包含密钥内容。
"""

from __future__ import annotations

import threading
from typing import Callable, Optional


class ImageKeyService:
    def __init__(
        self,
        downloader,
        *,
        interval_seconds: float = 60.0,
        logger: Callable[[str], None] = print,
    ):
        self._downloader = downloader
        self._interval = max(0.01, float(interval_seconds))
        self._logger = logger
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._announced: Optional[bool] = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="wechat-image-key-service", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=timeout)
        self._thread = None

    def refresh(self) -> bool:
        """显式刷新（账号切换/密钥文件更新后调用）。"""
        try:
            available = bool(self._downloader.refresh_image_key())
        except Exception as error:
            self._logger(f"wechat image key refresh failed: {type(error).__name__}")
            return False
        self._announce(available)
        return available

    def available(self) -> bool:
        try:
            return bool(self._downloader.has_image_key())
        except Exception:
            return False

    def _announce(self, available: bool) -> None:
        if self._announced is available:
            return
        self._announced = available
        if available:
            self._logger("wechat image key acquired")
        else:
            self._logger("wechat image key unavailable; background rescan scheduled")

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._announce(bool(self._downloader.try_acquire_image_key()))
            except Exception as error:
                self._logger(
                    f"wechat image key scan failed: {type(error).__name__}"
                )
            self._stop.wait(self._interval)

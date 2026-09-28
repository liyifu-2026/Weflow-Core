"""Run the local inbound-text Channel Host on Windows."""

from __future__ import annotations

from datetime import datetime
import os
from pathlib import Path
import threading
import time

from wechatauto import MediaDownloader, WeChatDB

from .backfill import BackfillRunner, load_backfill_config
from .event_store import EventStore
from .host import WeChatChannelHost
from .http_host import ChannelHostHttpServer
from .key_service import ImageKeyService
from .media import create_media_resolver
from .outbound import WeChatChannelSender, process_send_operations


def _log(message: str) -> None:
    """A4：带时间戳的统一日志格式。

    本模块此前用裸 print，主循环异常日志无时间戳，停摆发生时间无法定位
    （/error-log 错题本：捕获链路静默停摆不可观测）。模块内无 logging
    框架，保持 print 但格式规范。
    """
    print(f"{datetime.now().isoformat(timespec='seconds')} [channel-host] {message}")


def _wechat_process_probe(db: WeChatDB, health: dict, interval_seconds: float = 30.0):
    """A4：微信进程存活探测（30s 节流），结果缓存进 health。

    wechatauto.db._find_weixin_pids 依赖 tasklist 子进程，较重；
    1s 轮询里每秒都查不可接受，30s 探测一次足够 /status 观测用。
    """
    last_check = 0.0

    def probe() -> bool:
        nonlocal last_check
        now = time.monotonic()
        if now - last_check < interval_seconds:
            return bool(health.get("wechat_process_alive"))
        last_check = now
        try:
            alive = bool(db._find_weixin_pids())
        except Exception:
            # 探测失败按"不可确认"处理，绝不让健康探测本身打断主循环
            alive = False
        health["wechat_process_alive"] = alive
        return alive

    return probe


def main() -> None:
    token = _required_env("CHANNEL_HOST_TOKEN")
    store_path = Path(
        os.getenv("CHANNEL_HOST_EVENT_STORE", ".data/channel-host.sqlite3")
    )
    store_path.parent.mkdir(parents=True, exist_ok=True)
    # A4：捕获链路运行时健康状态（进程内共享 dict）。此前主循环 poll 异常
    # 只裸 print、HTTP /status 的 wechat_process_alive 恒为 null，微信退出
    # 或轮询连续失败时 Core 完全看不到（静默停摆）。该 dict 由主循环每轮
    # 更新，并注入 HTTP server 由 /api/v1/status 增量透出。
    runtime_health: dict = {
        "last_poll_ok_at": None,         # 最近一次完整成功周期（ISO8601 本地时间）
        "last_poll_error": None,         # 最近一次周期异常摘要（截断防刷屏）
        "consecutive_poll_failures": 0,  # 连续失败轮数；任一轮成功即清零
        "wechat_process_alive": None,    # 微信进程存活（30s 节流探测的缓存值）
    }
    db = WeChatDB(
        db_dir=os.getenv("WECHAT_DB_DIR") or None,
        keys_file=os.getenv("WECHAT_KEYS_FILE") or None,
        account=os.getenv("WECHAT_ACCOUNT") or None,
    )
    event_store = EventStore(str(store_path))
    media_staging = Path(
        os.getenv("CHANNEL_HOST_MEDIA_STAGING", ".data/channel-host-media")
    )
    # 图片 AES 密钥注入：环境变量显式指定，或通过 keys 文件按账号管理。
    # 密钥属于 secrets：不得打印到日志，密钥文件必须留在 .gitignore 内。
    downloader = MediaDownloader(
        db,
        save_dir=str(media_staging),
        image_key=os.getenv("WECHAT_IMAGE_KEY") or None,
        keys_file=os.getenv("WECHAT_IMAGE_KEYS_FILE") or None,
    )
    media_resolver = create_media_resolver(
        event_store,
        downloader,
        str(media_staging),
        # 原图 UI 下载开关（默认关）：开启后，原图/缩略图不可用或仅缩略图时，
        # 后台线程用 UI 自动化触发微信下载原图（会短暂抢占微信窗口），
        # 成果缓存于 <media_staging>/ui-original/，下次请求直接升级为原图。
        ui_original_enabled=os.getenv("WECHAT_MEDIA_ORIGINAL_VIA_UI", "").strip() == "1",
    )
    key_service = ImageKeyService(
        downloader,
        interval_seconds=float(
            os.getenv("WECHAT_IMAGE_KEY_RESCAN_INTERVAL_SECONDS", "60")
        ),
        logger=lambda message: print(f"[media-key] {message}"),
    )
    event_store.recover_send_operation_leases()
    # ADR-0005：多微信账号隔离——本实例账号由 WECHAT_ACCOUNT 标识，
    # 事件/联系人携带该值，发送请求校验一致后才执行。
    account = os.getenv("WECHAT_ACCOUNT") or None
    host = WeChatChannelHost(
        db,
        event_store,
        logger=lambda message: print(message),
        message_chat_discovery_interval_seconds=float(
            os.getenv("CHANNEL_HOST_MESSAGE_CHAT_DISCOVERY_INTERVAL_SECONDS", "30")
        ),
        account=account,
    )
    sender = WeChatChannelSender(db)
    # 空库历史回溯：store 纪元内无任何捕获时，把微信历史会话/消息合成
    # historical 事件回溯入库（绝不外发/建 Turn/记忆/通知）。手动端点
    # POST /api/v1/channel/backfill 复用同一 runner。
    backfill_config = load_backfill_config()
    backfill_runner = BackfillRunner(
        host,
        event_store,
        backfill_config,
        logger=lambda message: print(f"[backfill] {message}"),
    )
    # A4：启动即探测一次，/status 从第一笔请求起就有真实的进程存活值；
    # 之后主循环每轮调用（内部 30s 节流，不会每秒起 tasklist 子进程）。
    wechat_alive_probe = _wechat_process_probe(db, runtime_health)
    wechat_alive_probe()
    http_server = ChannelHostHttpServer(
        event_store,
        token=token,
        host=os.getenv("CHANNEL_HOST_BIND", "127.0.0.1"),
        port=int(os.getenv("CHANNEL_HOST_PORT", "43123")),
        # A4：注入进程存活缓存读取器（主循环负责周期探测），/status 的
        # wechat_process_alive 不再恒为 null。
        wechat_process_alive=lambda: runtime_health.get("wechat_process_alive"),
        media_resolver=media_resolver,
        contact_reader=db.list_contacts,
        key_refresh=key_service.refresh,
        account=account,
        backfill_runner=backfill_runner,
        # A4：健康状态对象透传给 HTTP server，/api/v1/status 增量上报
        runtime_health=runtime_health,
    )
    http_server.start()
    key_service.start()
    stop = threading.Event()
    interval = float(os.getenv("CHANNEL_HOST_POLL_INTERVAL_SECONDS", "1"))
    try:
        _log(f"Channel Host listening at {http_server.base_url}")
        # 空库判定必须在 bootstrap 之前：bootstrap 会写入各会话水位，
        # 之后 source_checkpoints 非空，空库信号即消失。
        auto_backfill = backfill_runner.should_auto_run()
        host.bootstrap()
        if auto_backfill:
            print("[backfill] empty store detected; starting historical backfill")
            backfill_runner.start_async(auto=False)
        while not stop.wait(interval):
            # A4：进程存活探测走 30s 节流，正常轮询周期内开销可忽略
            wechat_alive_probe()
            try:
                host.poll_once()
                process_send_operations(event_store, sender)
            except Exception as error:
                runtime_health["last_poll_error"] = (
                    f"{type(error).__name__}: {error}"
                )[:500]
                runtime_health["consecutive_poll_failures"] = int(
                    runtime_health["consecutive_poll_failures"]
                ) + 1
                _log(
                    "Channel Host cycle failed "
                    f"(consecutive={runtime_health['consecutive_poll_failures']}): "
                    f"{error}"
                )
            else:
                runtime_health["last_poll_ok_at"] = datetime.now().isoformat(
                    timespec="seconds"
                )
                runtime_health["last_poll_error"] = None
                runtime_health["consecutive_poll_failures"] = 0
    except KeyboardInterrupt:
        pass
    finally:
        key_service.stop()
        http_server.close()
        event_store.close()


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


if __name__ == "__main__":
    main()

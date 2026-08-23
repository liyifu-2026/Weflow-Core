"""Run the local inbound-text Channel Host on Windows."""

from __future__ import annotations

import os
from pathlib import Path
import threading
from typing import Callable, Optional

from wechatauto import MediaDownloader, WeChatDB

from .event_store import EventStore
from .host import WeChatChannelHost
from .http_host import ChannelHostHttpServer
from .key_service import ImageKeyService
from .media import create_media_resolver
from .outbound import WeChatChannelSender, process_send_operations


def _capture_emoji(
    db: WeChatDB,
    media_staging: Path,
) -> Callable[[str, int], Optional[str]]:
    def capture(conversation_ref: str, local_id: int) -> Optional[str]:
        from wechatauto import WeChatGUI
        from wechatauto.wx import Chat, _db_row_to_message

        row = db.get_message_row(conversation_ref, int(local_id))
        if not row:
            return None
        save_dir = media_staging / "emoji"
        save_dir.mkdir(parents=True, exist_ok=True)
        try:
            chat = Chat(who=conversation_ref, gui=WeChatGUI(), db=db)
            msg = _db_row_to_message(row, chat)
            if hasattr(msg, "capture"):
                return msg.capture(save_dir=str(save_dir))
        except Exception as error:
            print(f"emoji capture failed: {error}")
        return None

    return capture


def main() -> None:
    token = _required_env("CHANNEL_HOST_TOKEN")
    store_path = Path(
        os.getenv("CHANNEL_HOST_EVENT_STORE", ".data/channel-host.sqlite3")
    )
    store_path.parent.mkdir(parents=True, exist_ok=True)
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
        emoji_capture=_capture_emoji(db, media_staging),
    )
    key_service = ImageKeyService(
        downloader,
        interval_seconds=float(
            os.getenv("WECHAT_IMAGE_KEY_RESCAN_INTERVAL_SECONDS", "60")
        ),
        logger=lambda message: print(f"[media-key] {message}"),
    )
    event_store.recover_send_operation_leases()
    host = WeChatChannelHost(
        db,
        event_store,
        logger=lambda message: print(message),
        message_chat_discovery_interval_seconds=float(
            os.getenv("CHANNEL_HOST_MESSAGE_CHAT_DISCOVERY_INTERVAL_SECONDS", "30")
        ),
    )
    sender = WeChatChannelSender(db)
    http_server = ChannelHostHttpServer(
        event_store,
        token=token,
        host=os.getenv("CHANNEL_HOST_BIND", "127.0.0.1"),
        port=int(os.getenv("CHANNEL_HOST_PORT", "43123")),
        media_resolver=media_resolver,
        contact_reader=db.list_contacts,
        key_refresh=key_service.refresh,
    )
    http_server.start()
    key_service.start()
    stop = threading.Event()
    interval = float(os.getenv("CHANNEL_HOST_POLL_INTERVAL_SECONDS", "1"))
    try:
        print(f"Channel Host listening at {http_server.base_url}")
        host.bootstrap()
        while not stop.wait(interval):
            try:
                host.poll_once()
                process_send_operations(event_store, sender)
            except Exception as error:
                print(f"Channel Host cycle failed: {error}")
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

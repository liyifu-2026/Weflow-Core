import tempfile
import unittest
from pathlib import Path

from channel_host.event_store import ChannelObservation, EventStore
from channel_host.media import create_media_resolver


class FakeDownloader:
    def __init__(self, pending=False, thumbnail=False):
        self.pending = pending
        self.thumbnail = thumbnail
        self.calls = []
        self.thumb_calls = []
        self.voice_calls = []

    def download_image(self, user, local_id, save_dir=None, allow_key_scan=True):
        self.calls.append(
            {
                "user": user,
                "local_id": local_id,
                "save_dir": save_dir,
                "allow_key_scan": allow_key_scan,
            }
        )
        if self.pending:
            raise RuntimeError("image key unavailable")
        path = Path(save_dir) / "decoded.jpg"
        path.write_bytes(b"decoded")
        return str(path)

    def download_image_thumbnail(self, user, local_id, save_dir=None):
        self.thumb_calls.append((user, local_id, save_dir))
        if not self.thumbnail:
            return None
        path = Path(save_dir) / "thumb.jpg"
        path.write_bytes(b"thumbnail-bytes")
        return str(path)

    def download_voice(self, user, local_id, save_dir=None):
        self.voice_calls.append((user, local_id, save_dir))
        if self.pending:
            raise RuntimeError("voice blob not yet flushed")
        path = Path(save_dir) / "voice.silk"
        path.write_bytes(b"\x02#!SILK_V3")
        return str(path)


def capture_event(store, media_ref, kind="image"):
    store.capture(
        ChannelObservation(
            event_id="wechat:room-1:2",
            conversation_ref="room-1",
            channel_message_id="2",
            sender_ref="wxid-contact",
            kind=kind,
            content="[image]" if kind == "image" else "",
            occurred_at=None,
            observed_at="2026-08-17T00:00:00+00:00",
            is_self=False,
            media_ref=media_ref,
            mime_type="audio/x-silk" if kind == "voice" else None,
        ),
        source_sort_seq=2,
    )


class ChannelMediaTests(unittest.TestCase):
    def test_resolver_uses_non_blocking_driver_and_original_variant(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            capture_event(store, "wechat-media:v1:abc")
            downloader = FakeDownloader()
            resolver = create_media_resolver(
                store, downloader, str(Path(directory) / "staging")
            )

            result = resolver("wechat-media:v1:abc")
            self.assertEqual(result.state, "ready")
            self.assertEqual(result.mime_type, "image/jpeg")
            self.assertEqual(result.variant, "original")
            self.assertEqual(downloader.calls[0]["user"], "room-1")
            self.assertEqual(downloader.calls[0]["local_id"], 2)
            self.assertFalse(downloader.calls[0]["allow_key_scan"])
            self.assertIsNotNone(result.cleanup)
            result.cleanup()
            self.assertFalse(Path(downloader.calls[0]["save_dir"]).exists())
            store.close()

    def test_missing_driver_key_falls_back_to_thumbnail(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            capture_event(store, "wechat-media:v1:thumb")
            downloader = FakeDownloader(pending=True, thumbnail=True)
            resolver = create_media_resolver(
                store, downloader, str(Path(directory) / "staging")
            )

            result = resolver("wechat-media:v1:thumb")
            self.assertEqual(result.state, "ready")
            self.assertEqual(result.variant, "thumbnail")
            self.assertEqual(downloader.thumb_calls[0][0], "room-1")
            self.assertEqual(downloader.thumb_calls[0][1], 2)
            result.cleanup()
            self.assertFalse(Path(downloader.thumb_calls[0][2]).exists())
            store.close()

    def test_original_and_thumbnail_both_missing_maps_to_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            capture_event(store, "wechat-media:v1:none")
            downloader = FakeDownloader(pending=True, thumbnail=False)
            result = create_media_resolver(
                store, downloader, str(Path(directory) / "staging")
            )("wechat-media:v1:none")
            self.assertEqual(result.state, "pending")
            store.close()

    def test_missing_driver_key_maps_to_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            capture_event(store, "wechat-media:v1:pending")
            downloader = FakeDownloader(pending=True)
            result = create_media_resolver(
                store, downloader, str(Path(directory) / "staging")
            )("wechat-media:v1:pending")
            self.assertEqual(result.state, "pending")
            store.close()

    def test_voice_media_ref_resolves_to_silk_stream(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            capture_event(store, "wechat-media:v1:voice-1", kind="voice")
            downloader = FakeDownloader()
            resolver = create_media_resolver(
                store, downloader, str(Path(directory) / "staging")
            )

            result = resolver("wechat-media:v1:voice-1")
            self.assertEqual(result.state, "ready")
            self.assertEqual(result.mime_type, "audio/x-silk")
            self.assertEqual(downloader.voice_calls[0][0], "room-1")
            self.assertEqual(downloader.voice_calls[0][1], 2)
            self.assertIsNotNone(result.cleanup)
            result.cleanup()
            self.assertFalse(Path(downloader.voice_calls[0][2]).exists())
            store.close()

    def test_voice_media_ref_pending_when_driver_cannot_extract(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            capture_event(store, "wechat-media:v1:voice-pending", kind="voice")
            downloader = FakeDownloader(pending=True)
            result = create_media_resolver(
                store, downloader, str(Path(directory) / "staging")
            )("wechat-media:v1:voice-pending")
            self.assertEqual(result.state, "pending")
            store.close()


if __name__ == "__main__":
    unittest.main()

import json
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from channel_host.event_store import ChannelObservation, EventStore
from channel_host.http_host import (
    ChannelHostHttpServer,
    ChannelMediaReadResult,
)


class HttpHostTests(unittest.TestCase):
    def test_media_endpoint_streams_authenticated_image_and_maps_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "staged-image.jpg"
            image_path.write_bytes(b"fake-jpeg")
            results = {
                "media-ready": ChannelMediaReadResult.ready(
                    str(image_path), "image/jpeg"
                ),
                "media-pending": ChannelMediaReadResult.pending(),
            }
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(
                store,
                token="host-secret",
                media_resolver=results.__getitem__,
            )
            server.start()
            try:
                request = Request(
                    f"{server.base_url}/api/v1/channel/media/media-ready",
                    headers={"Authorization": "Bearer host-secret"},
                )
                response = urlopen(request)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Content-Type"], "image/jpeg")
                self.assertEqual(response.headers["X-Media-Variant"], "original")
                self.assertEqual(response.read(), b"fake-jpeg")

                pending = Request(
                    f"{server.base_url}/api/v1/channel/media/media-pending",
                    headers={"Authorization": "Bearer host-secret"},
                )
                pending_response = urlopen(pending)
                self.assertEqual(pending_response.status, 202)
                self.assertEqual(
                    json.loads(pending_response.read()),
                    {"error": "media_pending"},
                )
            finally:
                server.close()
                store.close()

    def test_media_endpoint_streams_file_attachments_with_content_disposition(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "staged.pdf"
            pdf_path.write_bytes(b"%PDF-1.7 fake")
            results = {
                "file-ref": ChannelMediaReadResult.ready(
                    str(pdf_path), "application/pdf", file_name="季度报告.pdf"
                ),
            }
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(
                store,
                token="host-secret",
                media_resolver=results.__getitem__,
            )
            server.start()
            try:
                request = Request(
                    f"{server.base_url}/api/v1/channel/media/file-ref",
                    headers={"Authorization": "Bearer host-secret"},
                )
                response = urlopen(request)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Content-Type"], "application/pdf")
                disposition = response.headers["Content-Disposition"]
                self.assertTrue(disposition.startswith("attachment; filename*=UTF-8''"))
                encoded_name = disposition.split("UTF-8''", 1)[1]
                self.assertEqual(urllib.parse.unquote(encoded_name), "季度报告.pdf")
                self.assertEqual(response.read(), b"%PDF-1.7 fake")
            finally:
                server.close()
                store.close()

    def test_media_endpoint_streams_silk_voice_with_audio_mime(self):
        with tempfile.TemporaryDirectory() as directory:
            silk_path = Path(directory) / "staged.silk"
            silk_path.write_bytes(b"\x02#!SILK_V3")
            results = {
                "voice-ref": ChannelMediaReadResult.ready(
                    str(silk_path), "audio/x-silk"
                ),
            }
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(
                store,
                token="host-secret",
                media_resolver=results.__getitem__,
            )
            server.start()
            try:
                request = Request(
                    f"{server.base_url}/api/v1/channel/media/voice-ref",
                    headers={"Authorization": "Bearer host-secret"},
                )
                response = urlopen(request)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Content-Type"], "audio/x-silk")
                self.assertEqual(response.read(), b"\x02#!SILK_V3")
            finally:
                server.close()
                store.close()

    def test_media_variant_header_marks_thumbnail_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            thumb_path = Path(directory) / "staged-thumb.jpg"
            thumb_path.write_bytes(b"fake-thumb-jpeg")
            results = {
                "thumb-ref": ChannelMediaReadResult.ready(
                    str(thumb_path),
                    "image/jpeg",
                    cleanup=lambda: None,
                    variant="thumbnail",
                ),
            }
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(
                store,
                token="host-secret",
                media_resolver=results.__getitem__,
            )
            server.start()
            try:
                request = Request(
                    f"{server.base_url}/api/v1/channel/media/thumb-ref",
                    headers={"Authorization": "Bearer host-secret"},
                )
                response = urlopen(request)
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    response.headers["X-Media-Variant"], "thumbnail"
                )
            finally:
                server.close()
                store.close()

    def test_media_key_refresh_endpoint_auth_gate_and_result(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            calls = []

            def refresh() -> bool:
                calls.append(1)
                return True

            server = ChannelHostHttpServer(
                store, token="host-secret", key_refresh=refresh
            )
            server.start()
            try:
                with self.assertRaises(HTTPError) as unauthorized:
                    urlopen(
                        Request(
                            f"{server.base_url}/api/v1/channel/media-key/refresh",
                            data=b"",
                            method="POST",
                        )
                    )
                self.assertEqual(unauthorized.exception.code, 401)

                request = Request(
                    f"{server.base_url}/api/v1/channel/media-key/refresh",
                    data=b"",
                    headers={"Authorization": "Bearer host-secret"},
                    method="POST",
                )
                response = urlopen(request)
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    json.loads(response.read()), {"available": True}
                )
                self.assertEqual(len(calls), 1)
            finally:
                server.close()
                store.close()

    def test_media_key_refresh_without_handler_returns_501(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(store, token="host-secret")
            server.start()
            try:
                request = Request(
                    f"{server.base_url}/api/v1/channel/media-key/refresh",
                    data=b"",
                    headers={"Authorization": "Bearer host-secret"},
                    method="POST",
                )
                with self.assertRaises(HTTPError) as not_implemented:
                    urlopen(request)
                self.assertEqual(not_implemented.exception.code, 501)
            finally:
                server.close()
                store.close()

    def test_pull_is_authenticated_paginated_and_replayable(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            store.capture(
                ChannelObservation(
                    event_id="event-1",
                    conversation_ref="room-1",
                    channel_message_id=None,
                    sender_ref=None,
                    kind="text",
                    content="hello",
                    occurred_at=None,
                    observed_at="2026-08-17T00:00:00+00:00",
                    is_self=False,
                ),
                source_sort_seq=1,
            )
            store.capture(
                ChannelObservation(
                    event_id="event-2",
                    conversation_ref="room-1",
                    channel_message_id="2",
                    sender_ref="wxid-contact",
                    kind="text",
                    content="second",
                    occurred_at=None,
                    observed_at="2026-08-17T00:00:02+00:00",
                    is_self=False,
                ),
                source_sort_seq=2,
            )
            server = ChannelHostHttpServer(store, token="host-secret")
            server.start()
            try:
                with self.assertRaises(HTTPError) as unauthorized:
                    urlopen(f"{server.base_url}/api/v1/channel/events")
                self.assertEqual(unauthorized.exception.code, 401)

                request = Request(
                    f"{server.base_url}/api/v1/channel/events?afterCursor=0&limit=1",
                    headers={"Authorization": "Bearer host-secret"},
                )
                first = json.loads(urlopen(request).read())
                replay = json.loads(urlopen(request).read())
                self.assertEqual(first, replay)
                self.assertEqual(first["events"][0]["eventId"], "event-1")
                self.assertIsNone(first["events"][0]["channelMessageId"])
                self.assertEqual(first["nextCursor"], "1")
                self.assertTrue(first["hasMore"])
                next_request = Request(
                    f"{server.base_url}/api/v1/channel/events?afterCursor=1&limit=1",
                    headers={"Authorization": "Bearer host-secret"},
                )
                second = json.loads(urlopen(next_request).read())
                self.assertEqual(second["events"][0]["eventId"], "event-2")
                self.assertFalse(second["hasMore"])
            finally:
                server.close()
                store.close()

    def test_contacts_endpoint_is_authenticated_paginated_and_replayable(self):
        pages = {
            "": {
                "contacts": [
                    {
                        "contactRef": "wxid-a",
                        "displayName": "Alice",
                        "nickname": "Alice",
                        "remark": None,
                        "alias": "alice",
                        "avatarUrl": None,
                        "contactType": "friend",
                    }
                ],
                "nextCursor": "opaque-after-a",
                "hasMore": True,
            },
            "opaque-after-a": {
                "contacts": [
                    {
                        "contactRef": "wxid-b",
                        "displayName": "Bob",
                        "nickname": "Bob",
                        "remark": "Support",
                        "alias": None,
                        "avatarUrl": "https://example.test/bob.png",
                        "contactType": "friend",
                    }
                ],
                "nextCursor": "opaque-after-b",
                "hasMore": False,
            },
        }
        calls = []

        def read_contacts(after_cursor: str, limit: int) -> dict:
            calls.append((after_cursor, limit))
            return pages[after_cursor]

        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(
                store,
                token="host-secret",
                contact_reader=read_contacts,
            )
            server.start()
            try:
                with self.assertRaises(HTTPError) as unauthorized:
                    urlopen(f"{server.base_url}/api/v1/channel/contacts")
                self.assertEqual(unauthorized.exception.code, 401)

                first_request = Request(
                    f"{server.base_url}/api/v1/channel/contacts?afterCursor=&limit=1",
                    headers={"Authorization": "Bearer host-secret"},
                )
                first = json.loads(urlopen(first_request).read())
                replay = json.loads(urlopen(first_request).read())
                self.assertEqual(first, replay)
                self.assertEqual(first["contacts"][0]["contactRef"], "wxid-a")
                self.assertEqual(first["nextCursor"], "opaque-after-a")
                self.assertTrue(first["hasMore"])

                second_request = Request(
                    f"{server.base_url}/api/v1/channel/contacts"
                    "?afterCursor=opaque-after-a&limit=1",
                    headers={"Authorization": "Bearer host-secret"},
                )
                second = json.loads(urlopen(second_request).read())
                self.assertEqual(second["contacts"][0]["contactRef"], "wxid-b")
                self.assertFalse(second["hasMore"])
                self.assertEqual(
                    calls,
                    [("", 1), ("", 1), ("opaque-after-a", 1)],
                )
            finally:
                server.close()
                store.close()


if __name__ == "__main__":
    unittest.main()

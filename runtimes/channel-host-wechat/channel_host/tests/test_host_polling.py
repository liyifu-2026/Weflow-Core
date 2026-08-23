import tempfile
import unittest
from pathlib import Path

from channel_host.event_store import EventStore
from channel_host.host import WeChatChannelHost


class FakeWeChatDb:
    def __init__(self):
        self.messages = {"room-1": []}
        self.get_messages_calls = []
        self.get_new_messages_calls = []
        self.list_message_chats_calls = 0

    def list_message_chats(self):
        self.list_message_chats_calls += 1
        return [
            {
                "username": username,
                "max_sort_seq": max(
                    (message["sort_seq"] for message in messages),
                    default=0,
                ),
            }
            for username, messages in self.messages.items()
        ]

    def get_sessions(self, limit=10000):
        return [
            {
                "username": username,
                "last_time": messages[-1].get("create_time") if messages else None,
                "summary": messages[-1].get("content") if messages else None,
                "last_sender": messages[-1].get("sender_id") if messages else None,
            }
            for username, messages in list(self.messages.items())[:limit]
        ]

    def get_messages(self, user, limit=20, offset=0):
        self.get_messages_calls.append(user)
        return list(reversed(self.messages[user]))[offset : offset + limit]

    def get_new_messages(self, user, since_seq=0, limit=200):
        self.get_new_messages_calls.append(user)
        return [
            message
            for message in self.messages[user]
            if message["sort_seq"] > since_seq
        ][:limit]

    def get_self_info(self):
        return {"username": "wxid_self"}


class HostPollingTests(unittest.TestCase):
    def test_bootstrap_uses_bulk_message_watermarks_not_one_read_per_conversation(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            for index in range(100):
                room = f"room-{index}"
                db.messages[room] = [
                    {
                        "local_id": index + 1,
                        "type": "文本",
                        "sender_id": "wxid-contact",
                        "create_time": 1_700_000_000 + index,
                        "content": "old",
                        "sort_seq": index + 10,
                    }
                ]

            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)

            self.assertTrue(host.bootstrap())
            self.assertEqual(db.list_message_chats_calls, 1)
            self.assertEqual(db.get_messages_calls, [])
            self.assertEqual(store.source_checkpoint("room-99"), 109)
            self.assertEqual(store.pull().events, [])
            store.close()

    def test_poll_reads_only_sessions_whose_discovery_key_changed(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-2"] = [
                {
                    "local_id": 2,
                    "type": "文本",
                    "sender_id": "wxid-contact-2",
                    "create_time": 1_700_000_000,
                    "content": "old-2",
                    "sort_seq": 20,
                }
            ]
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()

            db.messages["room-2"].append(
                {
                    "local_id": 3,
                    "type": "文本",
                    "sender_id": "wxid-contact-2",
                    "create_time": 1_700_000_001,
                    "content": "new-2",
                    "sort_seq": 21,
                }
            )

            self.assertEqual(host.poll_once(), 1)
            self.assertEqual(db.get_new_messages_calls, ["room-2"])
            self.assertEqual(
                [event["content"] for event in store.pull().events], ["new-2"]
            )
            store.close()

    def test_new_session_is_lazily_baselined_without_importing_its_history(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()

            db.messages["room-2"] = [
                {
                    "local_id": 2,
                    "type": "文本",
                    "sender_id": "wxid-contact-2",
                    "create_time": 1_700_000_000,
                    "content": "history",
                    "sort_seq": 20,
                }
            ]

            self.assertEqual(host.poll_once(), 0)
            self.assertEqual(db.get_messages_calls, ["room-2"])
            self.assertEqual(store.source_checkpoint("room-2"), 20)
            self.assertEqual(store.pull().events, [])
            store.close()

    def test_bootstrap_skips_history_and_captures_new_text_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"].append(
                {
                    "local_id": 1,
                    "type": "文本",
                    "sender_id": "wxid_contact",
                    "create_time": 1_700_000_000,
                    "content": "old",
                    "sort_seq": 10,
                }
            )
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            self.assertEqual(store.pull().events, [])

            db.messages["room-1"].append(
                {
                    "local_id": 2,
                    "type": "文本",
                    "sender_id": "wxid_contact",
                    "create_time": 1_700_000_001,
                    "content": "new",
                    "sort_seq": 11,
                }
            )
            self.assertEqual(host.poll_once(), 1)
            self.assertEqual(host.poll_once(), 0)
            store.close()

            reopened_store = EventStore(str(Path(directory) / "events.sqlite3"))
            restarted_host = WeChatChannelHost(db, reopened_store)
            restarted_host.bootstrap()
            db.messages["room-1"].append(
                {
                    "local_id": 3,
                    "type": "文本",
                    "sender_id": "wxid_contact",
                    "create_time": 1_700_000_002,
                    "content": "after restart",
                    "sort_seq": 12,
                }
            )
            self.assertEqual(restarted_host.poll_once(), 1)
            page = reopened_store.pull()
            self.assertEqual(
                [event["content"] for event in page.events],
                ["new", "after restart"],
            )
            self.assertEqual(
                [event["eventId"] for event in page.events],
                ["wechat:room-1:2", "wechat:room-1:3"],
            )
            self.assertEqual(
                [event["cursor"] for event in page.events], ["1", "2"]
            )
            reopened_store.close()

    def test_malformed_text_is_reported_and_does_not_block_later_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"].append(
                {
                    "local_id": 1,
                    "type": "文本",
                    "sender_id": "wxid-contact",
                    "create_time": 1_700_000_000,
                    "content": "baseline",
                    "sort_seq": 1,
                }
            )
            errors = []
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store, logger=errors.append)
            host.bootstrap()
            db.messages["room-1"].extend(
                [
                    {
                        "local_id": 2,
                        "type": "文本",
                        "sender_id": "wxid-contact",
                        "create_time": 1_700_000_001,
                        "content": None,
                        "sort_seq": 2,
                    },
                    {
                        "local_id": 3,
                        "type": "文本",
                        "sender_id": "wxid-contact",
                        "create_time": 1_700_000_002,
                        "content": "later",
                        "sort_seq": 3,
                    },
                ]
            )

            self.assertEqual(host.poll_once(), 1)
            self.assertEqual(len(errors), 1)
            self.assertEqual(store.pull().events[0]["eventId"], "wechat:room-1:3")
            store.close()

    def test_captures_image_with_stable_media_ref_without_parsing_media_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"].append(
                {
                    "local_id": 1,
                    "type": "图片",
                    "local_type": 3,
                    "server_id": "server-1",
                    "sender_id": "wxid-contact",
                    "create_time": 1_700_000_000,
                    "content": b"[image]",
                    "packed_info": b"opaque-image-payload",
                    "sort_seq": 1,
                }
            )
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()

            db.messages["room-1"].append(
                {
                    "local_id": 2,
                    "type": "图片",
                    "local_type": 3,
                    "server_id": "server-2",
                    "sender_id": "wxid-contact",
                    "create_time": 1_700_000_001,
                    "content": b"[image]",
                    "packed_info": b"opaque-image-payload-2",
                    "sort_seq": 2,
                }
            )

            self.assertEqual(host.poll_once(), 1)
            event = store.pull().events[0]
            self.assertEqual(event["kind"], "image")
            self.assertEqual(event["content"], "[image]")
            self.assertTrue(str(event["mediaRef"]).startswith("wechat-media:v1:"))
            self.assertNotIn("server-2", str(event["mediaRef"]))

            self.assertEqual(host.poll_once(), 0)
            store.close()

            reopened = EventStore(str(Path(directory) / "events.sqlite3"))
            self.assertEqual(reopened.pull().events[0]["mediaRef"], event["mediaRef"])
            reopened.close()

    def test_captures_file_appmessage_as_file_event_with_media_ref(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"].append(
                {
                    "local_id": 1,
                    "type": "文本",
                    "sender_id": "wxid-contact",
                    "create_time": 1_700_000_000,
                    "content": "baseline",
                    "sort_seq": 1,
                }
            )
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            db.messages["room-1"].append(
                {
                    "local_id": 2,
                    "type": "文件/链接/卡片",
                    "local_type": 49,
                    "sender_id": "wxid-contact",
                    "create_time": 1_700_000_001,
                    "content": (
                        '<?xml version="1.0"?><msg><appmsg appid="" sdkver="0">'
                        "<title>季度报告.pdf</title><des></des>"
                        "<type>6</type><appattach><totallen>1024</totallen>"
                        "</appattach></appmsg></msg>"
                    ),
                    "sort_seq": 2,
                }
            )

            self.assertEqual(host.poll_once(), 1)
            event = store.pull().events[0]
            self.assertEqual(event["kind"], "file")
            self.assertEqual(event["content"], "季度报告.pdf")
            self.assertTrue(str(event["mediaRef"]).startswith("wechat-media:v1:"))
            self.assertNotIn("季度", str(event["mediaRef"]))
            self.assertEqual(event["fileName"], "季度报告.pdf")
            self.assertEqual(event["mimeType"], "application/pdf")

            reopened = EventStore(str(Path(directory) / "events.sqlite3"))
            self.assertEqual(reopened.pull().events[0]["mediaRef"], event["mediaRef"])
            self.assertEqual(reopened.pull().events[0]["fileName"], "季度报告.pdf")
            reopened.close()
            store.close()

    def test_file_message_with_bytes_content_is_captured(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            db.messages["room-1"].append(
                {
                    "local_id": 1,
                    "local_type": 49,
                    "sender_id": "wxid-contact",
                    "create_time": 1_700_000_000,
                    "content": (
                        "<msg><appmsg><title>demo.zip</title>"
                        "<type>6</type></appmsg></msg>"
                    ).encode("utf-8"),
                    "sort_seq": 1,
                }
            )

            self.assertEqual(host.poll_once(), 1)
            event = store.pull().events[0]
            self.assertEqual(event["kind"], "file")
            self.assertEqual(event["content"], "demo.zip")
            self.assertEqual(event["fileName"], "demo.zip")
            store.close()

    def test_non_file_appmessages_are_not_captured_as_file(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            xml_by_type = {
                # 合并转发聊天记录
                19: "<msg><appmsg><title>聊天记录</title><type>19</type></appmsg></msg>",
                # 链接卡片
                5: "<msg><appmsg><title>一篇文章</title><type>5</type></appmsg></msg>",
                # 文件卡片但缺少 title
                None: "<msg><appmsg><type>6</type></appmsg></msg>",
                # 不是 XML
                "not-xml": "随手发的文本但被标成49",
            }
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            for index, (sub_type, content) in enumerate(xml_by_type.items(), start=1):
                db.messages["room-1"].append(
                    {
                        "local_id": index,
                        "local_type": 49,
                        "sender_id": "wxid-contact",
                        "create_time": 1_700_000_000 + index,
                        "content": content,
                        "sort_seq": index,
                    }
                )

            self.assertEqual(host.poll_once(), 0)
            page = store.pull()
            self.assertEqual(page.events, [])
            self.assertEqual(store.source_checkpoint("room-1"), len(xml_by_type))
            store.close()

    def test_captures_voice_with_transcript_and_stable_media_ref(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            db.messages["room-1"].append(
                {
                    "local_id": 1,
                    "type": "文本",
                    "sender_id": "wxid-contact",
                    "create_time": 1_700_000_000,
                    "content": "baseline",
                    "sort_seq": 1,
                }
            )
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()

            db.messages["room-1"].append(
                {
                    "local_id": 2,
                    "type": "语音",
                    "local_type": 34,
                    "sender_id": "wxid-contact",
                    "create_time": 1_700_000_001,
                    "content": "你好，请查收",
                    "sort_seq": 2,
                }
            )

            self.assertEqual(host.poll_once(), 1)
            event = store.pull().events[0]
            self.assertEqual(event["kind"], "voice")
            self.assertEqual(event["content"], "你好，请查收")
            self.assertTrue(str(event["mediaRef"]).startswith("wechat-media:v1:"))
            self.assertEqual(event["mimeType"], "audio/x-silk")

            reopened = EventStore(str(Path(directory) / "events.sqlite3"))
            self.assertEqual(reopened.pull().events[0]["mediaRef"], event["mediaRef"])
            reopened.close()
            store.close()

    def test_captures_voice_without_transcript_as_empty_content(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            for index, placeholder in enumerate(["[语音]5秒", "[语音]", ""], start=1):
                db.messages["room-1"].append(
                    {
                        "local_id": index,
                        "type": "语音",
                        "local_type": 34,
                        "sender_id": "wxid-contact",
                        "create_time": 1_700_000_000 + index,
                        "content": placeholder,
                        "sort_seq": index,
                    }
                )

            self.assertEqual(host.poll_once(), 3)
            events = store.pull().events
            self.assertEqual([event["kind"] for event in events], ["voice"] * 3)
            self.assertEqual([event["content"] for event in events], ["", "", ""])
            for event in events:
                self.assertTrue(str(event["mediaRef"]).startswith("wechat-media:v1:"))
                self.assertEqual(event["mimeType"], "audio/x-silk")
                self.assertNotIn("fileName", event)
            store.close()

    def test_group_voice_transcript_strips_sender_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            db.messages["room-1"].append(
                {
                    "local_id": 1,
                    "type": "语音",
                    "local_type": 34,
                    "sender_id": "wxid-contact",
                    "create_time": 1_700_000_000,
                    "content": "wxid_alice:\n明天上午十点开会",
                    "sort_seq": 1,
                }
            )

            self.assertEqual(host.poll_once(), 1)
            event = store.pull().events[0]
            self.assertEqual(event["kind"], "voice")
            self.assertEqual(event["content"], "明天上午十点开会")
            self.assertEqual(event["senderRef"], "wxid_alice")
            store.close()


if __name__ == "__main__":
    unittest.main()

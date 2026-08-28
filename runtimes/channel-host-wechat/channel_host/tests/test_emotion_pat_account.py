"""任务E回归：表情包文本化、拍一拍捕获与多账号 account 字段（ADR-0005）。"""

import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from channel_host.event_store import EventStore
from channel_host.host import WeChatChannelHost
from channel_host.http_host import ChannelHostHttpServer


class FakeWeChatDb:
    def __init__(self):
        self.messages = {"room-1": []}

    def list_message_chats(self):
        return [
            {
                "username": username,
                "max_sort_seq": max(
                    (message["sort_seq"] for message in messages), default=0
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
        return []

    def get_new_messages(self, user, since_seq=0, limit=200):
        return [
            message
            for message in self.messages[user]
            if message["sort_seq"] > since_seq
        ][:limit]

    def get_self_info(self):
        return {"username": "wxid_self"}


def _emotion(local_id, sort_seq, content, sender_id="wxid-contact"):
    return {
        "local_id": local_id,
        "type": "动画表情",
        "local_type": 47,
        "sender_id": sender_id,
        "create_time": 1_700_000_000 + local_id,
        "content": content,
        "sort_seq": sort_seq,
    }


def _pat(local_id, sort_seq, content, sender_id="wxid-contact"):
    return {
        "local_id": local_id,
        "type": "系统消息",
        "local_type": 10000,
        "sender_id": sender_id,
        "create_time": 1_700_000_000 + local_id,
        "content": content,
        "sort_seq": sort_seq,
    }


def _pat_appmsg(local_id, sort_seq, title, sender_id="wxid-contact"):
    """微信 4.x 实测：拍一拍以 type 49 appmsg 卡片落库（title=我拍了拍 "xxx"）。"""
    xml = (
        '<msg><appmsg appid="" sdkver="0">'
        f"<title>{title}</title>"
        "<type>33</type>"
        "</appmsg></msg>"
    )
    return {
        "local_id": local_id,
        "type": "文件/链接/卡片",
        "local_type": 49,
        "sender_id": sender_id,
        "create_time": 1_700_000_000 + local_id,
        "content": xml,
        "sort_seq": sort_seq,
    }


class EmotionTextTests(unittest.TestCase):
    def test_emotion_with_plain_text_name_becomes_sticker_text(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            db.messages["room-1"].append(_emotion(1, 1, "[偷笑]"))

            self.assertEqual(host.poll_once(), 1)
            event = store.pull().events[0]
            self.assertEqual(event["kind"], "emotion")
            self.assertEqual(event["content"], "[表情包]偷笑")
            self.assertTrue(str(event["mediaRef"]).startswith("wechat-media:v1:"))
            store.close()

    def test_emotion_name_is_normalized_through_mapping_table(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            db.messages["room-1"].append(_emotion(1, 1, "happy"))
            db.messages["room-1"].append(_emotion(2, 2, "[发怒]"))

            self.assertEqual(host.poll_once(), 2)
            contents = [event["content"] for event in store.pull().events]
            self.assertEqual(contents, ["[表情包]开心", "[表情包]生气"])
            store.close()

    def test_emotion_xml_without_name_falls_back_to_generic_sticker_text(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            db.messages["room-1"].append(
                _emotion(
                    1,
                    1,
                    '<?xml version="1.0"?><msg><emoji cdnurl='
                    '"http://example.test/s.gif" '
                    'md5="0123456789abcdef0123456789abcdef"/></msg>',
                )
            )
            db.messages["room-1"].append(
                _emotion(2, 2, "[动画表情]".encode("utf-8"))
            )

            self.assertEqual(host.poll_once(), 2)
            contents = [event["content"] for event in store.pull().events]
            self.assertEqual(contents, ["[表情包]表情", "[表情包]表情"])
            store.close()


class PatMessageTests(unittest.TestCase):
    def test_pat_system_message_is_captured_as_pat_event(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            db.messages["room-1"].append(_pat(1, 1, "「张三」拍了拍你"))

            self.assertEqual(host.poll_once(), 1)
            event = store.pull().events[0]
            self.assertEqual(event["kind"], "pat")
            self.assertEqual(event["content"], "对方拍了拍你")
            self.assertFalse(event["isSelf"])
            self.assertEqual(event["senderRef"], "wxid-contact")
            self.assertIsNone(event["mediaRef"])
            store.close()

    def test_group_pat_keeps_sender_ref_and_self_pat_marks_is_self(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            db.messages["room-1"].append(
                _pat(1, 1, "「wxid_alice」拍了拍「wxid_bob」", sender_id="wxid-alice")
            )
            db.messages["room-1"].append(
                _pat(2, 2, "你拍了拍「wxid_bob」", sender_id=2)
            )

            self.assertEqual(host.poll_once(), 2)
            events = store.pull().events
            self.assertEqual([event["kind"] for event in events], ["pat", "pat"])
            self.assertEqual(events[0]["senderRef"], "wxid-alice")
            self.assertFalse(events[0]["isSelf"])
            self.assertTrue(events[1]["isSelf"])
            store.close()

    def test_pat_appmsg_card_is_captured_with_title_text(self):
        """微信 4.x：拍一拍以 type 49 appmsg 卡片落库，title 含「拍了拍」。"""
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            db.messages["room-1"].append(
                _pat_appmsg(1, 1, '我拍了拍 "Leaif"', sender_id=2)
            )

            self.assertEqual(host.poll_once(), 1)
            event = store.pull().events[0]
            self.assertEqual(event["kind"], "pat")
            self.assertEqual(event["content"], '我拍了拍 "Leaif"')
            self.assertTrue(event["isSelf"])
            self.assertIsNone(event["mediaRef"])
            store.close()

    def test_other_system_messages_remain_uncaptured_without_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            host = WeChatChannelHost(db, store)
            host.bootstrap()
            db.messages["room-1"].append(
                _pat(1, 1, "你已添加了张三，现在可以开始聊天了。")
            )

            self.assertEqual(host.poll_once(), 0)
            self.assertEqual(store.pull().events, [])
            self.assertEqual(store.source_checkpoint("room-1"), 1)

            db.messages["room-1"].append(
                {
                    "local_id": 2,
                    "type": "文本",
                    "sender_id": "wxid-contact",
                    "create_time": 1_700_000_002,
                    "content": "later text",
                    "sort_seq": 2,
                }
            )
            self.assertEqual(host.poll_once(), 1)
            self.assertEqual(store.pull().events[0]["kind"], "text")
            store.close()


class AccountFieldTests(unittest.TestCase):
    def test_events_carry_configured_account_field(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events-a.sqlite3"))
            host = WeChatChannelHost(db, store, account="wx-account-a")
            try:
                host.bootstrap()
                db.messages["room-1"].append(
                    {
                        "local_id": 1,
                        "type": "文本",
                        "sender_id": "wxid-contact",
                        "create_time": 1_700_000_000,
                        "content": "hello",
                        "sort_seq": 1,
                    }
                )
                host.poll_once()
                self.assertEqual(store.pull().events[0]["account"], "wx-account-a")

                reopened = EventStore(str(Path(directory) / "events-a.sqlite3"))
                try:
                    self.assertEqual(
                        reopened.pull().events[0]["account"], "wx-account-a"
                    )
                finally:
                    reopened.close()
            finally:
                store.close()

    def test_events_default_to_null_account_when_unconfigured(self):
        with tempfile.TemporaryDirectory() as directory:
            db = FakeWeChatDb()
            store = EventStore(str(Path(directory) / "events-b.sqlite3"))
            host = WeChatChannelHost(db, store)
            try:
                host.bootstrap()
                db.messages["room-1"].append(
                    {
                        "local_id": 1,
                        "type": "文本",
                        "sender_id": "wxid-contact",
                        "create_time": 1_700_000_000,
                        "content": "hello",
                        "sort_seq": 1,
                    }
                )
                host.poll_once()
                self.assertIsNone(store.pull().events[0]["account"])
            finally:
                store.close()


class ContactAccountTests(unittest.TestCase):
    def test_contacts_endpoint_annotates_account_on_every_contact(self):
        pages = {
            "": {
                "contacts": [
                    {"contactRef": "wxid-a", "displayName": "Alice"},
                ],
                "nextCursor": "after-a",
                "hasMore": False,
            }
        }

        def read_contacts(after_cursor: str, limit: int) -> dict:
            return pages[after_cursor]

        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(
                store,
                token="host-secret",
                contact_reader=read_contacts,
                account="wx-account-a",
            )
            server.start()
            try:
                request = Request(
                    f"{server.base_url}/api/v1/channel/contacts",
                    headers={"Authorization": "Bearer host-secret"},
                )
                page = json.loads(urlopen(request).read())
                self.assertEqual(page["contacts"][0]["account"], "wx-account-a")
            finally:
                server.close()
                store.close()


class SendAccountValidationTests(unittest.TestCase):
    @staticmethod
    def _post(base_url, body):
        request = Request(
            f"{base_url}/api/v1/channel/send",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": "Bearer host-secret",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        return json.loads(urlopen(request).read())

    def _payload_body(self, operation_id, account=...):
        body = {
            "operationId": operation_id,
            "conversationRef": "wxid-contact",
            "payload": {"kind": "text", "text": "hello"},
        }
        if account is not ...:
            body["account"] = account
        return body

    def test_send_with_mismatched_account_is_rejected_without_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(store, token="host-secret", account="wx-a")
            server.start()
            try:
                with self.assertRaises(HTTPError) as mismatched:
                    self._post(
                        server.base_url,
                        self._payload_body("op-mismatch", account="wx-b"),
                    )
                self.assertEqual(mismatched.exception.code, 409)
                self.assertEqual(
                    json.loads(mismatched.exception.read()),
                    {"error": "account_mismatch"},
                )
                self.assertIsNone(store.get_send_operation("op-mismatch"))
            finally:
                server.close()
                store.close()

    def test_send_with_matching_account_is_accepted_and_absent_defaults_rejected(self):
        """实例显式配置账号后，缺省（=default）与不匹配账号都必须拒绝，
        防止未携带 account 的旧 Core 把消息发到错误的微信实例。"""
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(store, token="host-secret", account="wx-a")
            server.start()
            try:
                created = self._post(
                    server.base_url, self._payload_body("op-match", account="wx-a")
                )
                self.assertEqual(created["state"], "pending")

                for operation_id, account_value in (
                    ("op-absent", ...),
                    ("op-null", None),
                    ("op-default", "default"),
                ):
                    with self.assertRaises(HTTPError) as rejected:
                        self._post(
                            server.base_url,
                            self._payload_body(operation_id, account=account_value),
                        )
                    self.assertEqual(rejected.exception.code, 409)

                with self.assertRaises(HTTPError) as invalid:
                    self._post(
                        server.base_url,
                        self._payload_body("op-invalid", account=123),
                    )
                self.assertEqual(invalid.exception.code, 400)
            finally:
                server.close()
                store.close()

    def test_unconfigured_instance_treats_absent_account_as_default(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(store, token="host-secret")
            server.start()
            try:
                default_ok = self._post(
                    server.base_url,
                    self._payload_body("op-default", account="default"),
                )
                self.assertEqual(default_ok["state"], "pending")
                absent_ok = self._post(
                    server.base_url, self._payload_body("op-absent-default")
                )
                self.assertEqual(absent_ok["state"], "pending")

                with self.assertRaises(HTTPError) as mismatched:
                    self._post(
                        server.base_url,
                        self._payload_body("op-other", account="wx-b"),
                    )
                self.assertEqual(mismatched.exception.code, 409)
            finally:
                server.close()
                store.close()


if __name__ == "__main__":
    unittest.main()

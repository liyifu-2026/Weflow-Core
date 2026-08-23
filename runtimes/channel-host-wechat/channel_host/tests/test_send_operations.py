import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from channel_host.event_store import EventStore
from channel_host.http_host import ChannelHostHttpServer
from channel_host.outbound import (
    SendAttempt,
    WeChatChannelSender,
    process_send_operations,
)


class SendOperationContractTests(unittest.TestCase):
    def test_create_is_durable_idempotent_and_fails_on_payload_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(store, token="host-secret")
            server.start()
            try:
                body = {
                    "operationId": "op-1",
                    "conversationRef": "wxid-contact",
                    "payload": {"kind": "text", "text": "hello"},
                }
                first = self._post(server.base_url, body)
                replay = self._post(server.base_url, body)

                self.assertEqual(first, replay)
                self.assertEqual(first["state"], "pending")
                self.assertIsNone(first["error"])
                self.assertEqual(first["operationId"], "op-1")

                fetched = self._get(
                    f"{server.base_url}/api/v1/channel/send-operations/op-1"
                )
                self.assertEqual(fetched, first)

                with self.assertRaises(HTTPError) as conflict:
                    self._post(
                        server.base_url,
                        {
                            **body,
                            "payload": {"kind": "text", "text": "different"},
                        },
                    )
                self.assertEqual(conflict.exception.code, 409)
            finally:
                server.close()
                store.close()

    def test_pending_operation_is_sent_once_and_replayed_without_duplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            store.create_send_operation(
                "op-send",
                "wxid-contact",
                {"kind": "text", "text": "hello"},
            )
            sender = FakeSender()

            self.assertEqual(process_send_operations(store, sender), 1)
            operation = store.get_send_operation("op-send")
            self.assertIsNotNone(operation)
            self.assertEqual(operation["state"], "confirmed")
            self.assertEqual(operation["channelMessageId"], "local-1")
            self.assertEqual(sender.send_calls, 1)

            self.assertEqual(process_send_operations(store, sender), 0)
            self.assertEqual(sender.send_calls, 1)
            store.close()

    def test_http_operation_becomes_confirmed_after_host_executor_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(store, token="host-secret")
            server.start()
            try:
                created = self._post(
                    server.base_url,
                    {
                        "operationId": "op-http",
                        "conversationRef": "wxid-contact",
                        "payload": {"kind": "text", "text": "hello"},
                    },
                )
                self.assertEqual(created["state"], "pending")
                process_send_operations(store, FakeSender())
                confirmed = self._get(
                    f"{server.base_url}/api/v1/channel/send-operations/op-http"
                )
                self.assertEqual(confirmed["state"], "confirmed")
                self.assertEqual(confirmed["channelMessageId"], "local-1")
            finally:
                server.close()
                store.close()

    def test_restart_reconciles_a_send_that_was_observed_before_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            store.create_send_operation(
                "op-crash",
                "wxid-contact",
                {"kind": "text", "text": "hello"},
            )
            claim = store.claim_send_operation("op-crash", 41)
            self.assertIsNotNone(claim)
            store.recover_send_operation_leases()
            sender = FakeSender(found_message_id="local-after-crash")

            self.assertEqual(process_send_operations(store, sender), 1)
            operation = store.get_send_operation("op-crash")
            self.assertIsNotNone(operation)
            self.assertEqual(operation["state"], "confirmed")
            self.assertEqual(operation["channelMessageId"], "local-after-crash")
            self.assertEqual(sender.send_calls, 0)
            store.close()

    def test_crash_after_ui_action_reconciles_without_a_second_send(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            store.create_send_operation(
                "op-ui-crash",
                "wxid-contact",
                {"kind": "text", "text": "hello"},
            )
            sender = CrashAfterUiActionSender()

            with self.assertRaises(RuntimeError):
                process_send_operations(store, sender)

            store.recover_send_operation_leases()
            self.assertEqual(process_send_operations(store, sender), 1)
            operation = store.get_send_operation("op-ui-crash")
            self.assertEqual(operation["state"], "confirmed")
            self.assertEqual(operation["channelMessageId"], "local-after-crash")
            self.assertEqual(sender.send_calls, 1)
            store.close()

    def test_crash_recovery_without_db_evidence_becomes_unknown_without_resend(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            store.create_send_operation(
                "op-ui-unknown",
                "wxid-contact",
                {"kind": "text", "text": "hello"},
            )
            self.assertIsNotNone(store.claim_send_operation("op-ui-unknown", 41))
            store.recover_send_operation_leases()
            sender = NoEvidenceSender()

            self.assertEqual(process_send_operations(store, sender), 1)
            operation = store.get_send_operation("op-ui-unknown")
            self.assertEqual(operation["state"], "unknown")
            self.assertEqual(sender.send_calls, 0)
            store.close()

    def test_unknown_operation_is_not_automatically_sent_again(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            try:
                store.create_send_operation(
                    "op-unknown",
                    "wxid-contact",
                    {"kind": "text", "text": "hello"},
                )
                sender = AlwaysUnknownSender()

                with patch(
                    "channel_host.outbound.AMBIGUOUS_RECONCILIATION_SECONDS",
                    0.01,
                ):
                    self.assertEqual(process_send_operations(store, sender), 1)
                    self.assertEqual(
                        store.get_send_operation("op-unknown")["state"], "unknown"
                    )
                    self.assertEqual(sender.send_calls, 1)

                self.assertEqual(process_send_operations(store, sender), 0)
                self.assertEqual(sender.send_calls, 1)
                self.assertEqual(
                    store.get_send_operation("op-unknown")["state"], "unknown"
                )
            finally:
                store.close()

    def test_ambiguous_ui_send_is_reconciled_without_a_second_send(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            try:
                store.create_send_operation(
                    "op-delayed-confirmation",
                    "wxid-contact",
                    {"kind": "text", "text": "hello"},
                )
                sender = DelayedEvidenceSender()

                with patch(
                    "channel_host.outbound.AMBIGUOUS_RECONCILIATION_SECONDS",
                    0.05,
                ), patch(
                    "channel_host.outbound.AMBIGUOUS_RECONCILIATION_INTERVAL_SECONDS",
                    0.01,
                ):
                    self.assertEqual(process_send_operations(store, sender), 1)

                operation = store.get_send_operation("op-delayed-confirmation")
                self.assertEqual(operation["state"], "confirmed")
                self.assertEqual(operation["channelMessageId"], "local-delayed")
                self.assertEqual(sender.send_calls, 1)
            finally:
                store.close()

    def test_sender_marks_verified_ui_failure_as_failed(self):
        sender = WeChatChannelSender(
            db=FakeContactDb(),
            gui_factory=lambda: FakeGui(
                {"status": "失败", "message": "微信窗口不可见"}
            ),
        )

        self.assertEqual(
            sender.send_text("wxid-contact", "hello"),
            SendAttempt("failed", "微信窗口不可见"),
        )

    def test_sender_keeps_unconfirmed_ui_send_as_unknown(self):
        sender = WeChatChannelSender(
            db=FakeContactDb(),
            gui_factory=lambda: FakeGui(
                {"status": "失败", "message": "消息已操作发送，但数据库未确认"}
            ),
        )

        self.assertEqual(
            sender.send_text("wxid-contact", "hello"),
            SendAttempt("unknown", "消息已操作发送，但数据库未确认"),
        )

    def test_sender_keeps_nonstandard_ui_failure_as_unknown(self):
        sender = WeChatChannelSender(
            db=FakeContactDb(),
            gui_factory=lambda: FakeGui(False),
        )

        self.assertEqual(
            sender.send_text("wxid-contact", "hello"),
            SendAttempt("unknown", "wechat_send_not_confirmed"),
        )

    def test_sender_uses_visible_contact_name_for_gui_search(self):
        gui = FakeGui({"status": "失败", "message": "微信窗口不可见"})
        sender = WeChatChannelSender(
            db=FakeContactDb(),
            gui_factory=lambda: gui,
        )

        sender.send_text("wxid-contact", "hello")

        self.assertEqual(gui.target_name, "Leaif")

    def test_sender_fails_without_typing_opaque_ref_into_gui(self):
        gui_created = False

        def create_gui():
            nonlocal gui_created
            gui_created = True
            return FakeGui(False)

        sender = WeChatChannelSender(
            db=UnresolvedContactDb(),
            gui_factory=create_gui,
        )

        self.assertEqual(
            sender.send_text("wxid-contact", "hello"),
            SendAttempt("failed", "channel_contact_unresolved"),
        )
        self.assertFalse(gui_created)

    def test_operation_survives_event_store_and_http_host_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.sqlite3"
            first_store = EventStore(str(path))
            first_server = ChannelHostHttpServer(first_store, token="host-secret")
            first_server.start()
            try:
                operation = self._post(
                    first_server.base_url,
                    {
                        "operationId": "op-restart",
                        "conversationRef": "wxid-contact",
                        "payload": {"kind": "text", "text": "hello"},
                    },
                )
            finally:
                first_server.close()
                first_store.close()

            second_store = EventStore(str(path))
            second_server = ChannelHostHttpServer(second_store, token="host-secret")
            second_server.start()
            try:
                self.assertEqual(
                    self._get(
                        f"{second_server.base_url}/api/v1/channel/send-operations/op-restart"
                    ),
                    operation,
                )
            finally:
                second_server.close()
                second_store.close()

    def test_non_text_payload_is_rejected_without_creating_an_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(store, token="host-secret")
            server.start()
            try:
                with self.assertRaises(HTTPError) as unsupported:
                    self._post(
                        server.base_url,
                        {
                            "operationId": "op-image",
                            "conversationRef": "wxid-contact",
                            "payload": {"kind": "image", "mediaRef": "media-1"},
                        },
                    )
                self.assertEqual(unsupported.exception.code, 400)
                self.assertIsNone(store.get_send_operation("op-image"))
            finally:
                server.close()
                store.close()

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

    @staticmethod
    def _get(url):
        request = Request(url, headers={"Authorization": "Bearer host-secret"})
        return json.loads(urlopen(request).read())


class FakeSender:
    def __init__(self, found_message_id=None):
        self.found_message_id = found_message_id
        self.send_calls = 0

    def current_high_water(self, _conversation_ref):
        return 41

    def find_self_text_after(self, _conversation_ref, _text, _baseline_sort_seq):
        if self.found_message_id is not None:
            return self.found_message_id
        if self.send_calls > 0:
            return "local-1"
        return None

    def send_text(self, _conversation_ref, _text):
        self.send_calls += 1
        return SendAttempt("confirmed")


class AlwaysUnknownSender(FakeSender):
    def find_self_text_after(self, _conversation_ref, _text, _baseline_sort_seq):
        return None

    def send_text(self, _conversation_ref, _text):
        self.send_calls += 1
        return SendAttempt("unknown", "verification_timeout")


class DelayedEvidenceSender(FakeSender):
    def __init__(self):
        super().__init__()
        self.lookup_calls = 0

    def find_self_text_after(self, _conversation_ref, _text, _baseline_sort_seq):
        self.lookup_calls += 1
        if self.lookup_calls >= 2:
            return "local-delayed"
        return None

    def send_text(self, _conversation_ref, _text):
        self.send_calls += 1
        return SendAttempt("unknown", "verification_timeout")


class CrashAfterUiActionSender(FakeSender):
    def __init__(self):
        super().__init__()
        self.ui_action_happened = False

    def find_self_text_after(self, _conversation_ref, _text, _baseline_sort_seq):
        if self.ui_action_happened:
            return "local-after-crash"
        return None

    def send_text(self, _conversation_ref, _text):
        self.send_calls += 1
        self.ui_action_happened = True
        raise RuntimeError("simulated_host_crash_after_ui_action")


class NoEvidenceSender(FakeSender):
    def find_self_text_after(self, _conversation_ref, _text, _baseline_sort_seq):
        return None

    def send_text(self, _conversation_ref, _text):
        self.send_calls += 1
        return SendAttempt("confirmed")


class FakeGui:
    def __init__(self, result):
        self.result = result
        self.target_name = None

    def send_msg(self, _text, target_name, verify):
        assert verify is True
        self.target_name = target_name
        return self.result


class FakeContactDb:
    def get_nickname(self, _conversation_ref):
        return "Leaif"


class UnresolvedContactDb:
    def get_nickname(self, conversation_ref):
        return conversation_ref


if __name__ == "__main__":
    unittest.main()

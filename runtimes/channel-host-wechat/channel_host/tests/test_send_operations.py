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
    _dispatch_send,
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

    def test_sender_fails_when_nickname_unresolved_without_searching_wxid(self):
        gui = FakeGui(False)
        sender = WeChatChannelSender(
            db=UnresolvedContactDb(),
            gui_factory=lambda: gui,
        )
        # 无昵称记录时不应把 wxid 当搜索目标，而应干净失败且不触碰 GUI。
        attempt = sender.send_text("wxid-contact", "hello")
        self.assertEqual(attempt.state, "failed")
        self.assertIn("未找到可发送目标", attempt.error or "")
        self.assertIsNone(gui.target_name)

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

    def test_mention_with_contract_field_is_accepted_and_round_trips(self):
        """ADR-0006 回归：Core 发送 mentionContactRefs（契约字段）必须被接受。

        回归背景：Host 曾只认 legacy members 字段，契约 mention POST 一律
        400 且不落操作 —— Core 出站轮询每轮在 create() 处中断，队头堵塞
        冻结后续全部消息。
        """
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(store, token="host-secret")
            server.start()
            try:
                created = self._post(
                    server.base_url,
                    {
                        "operationId": "op-mention-contract",
                        "conversationRef": "45740750295@chatroom",
                        "payload": {
                            "kind": "mention",
                            "text": "@可可猫",
                            "mentionContactRefs": ["contact:channel:wxid_x:可可猫"],
                        },
                    },
                )
                self.assertEqual(created["state"], "pending")
                self.assertEqual(
                    created["payload"]["mentionContactRefs"],
                    ["contact:channel:wxid_x:可可猫"],
                )
                self.assertNotIn("members", created["payload"])
                fetched = self._get(
                    f"{server.base_url}/api/v1/channel/send-operations/op-mention-contract"
                )
                self.assertEqual(fetched, created)
                # legacy members 兼容：接受并归一化为契约字段
                legacy = self._post(
                    server.base_url,
                    {
                        "operationId": "op-mention-legacy",
                        "conversationRef": "45740750295@chatroom",
                        "payload": {
                            "kind": "mention",
                            "text": "@李四",
                            "members": ["李四"],
                        },
                    },
                )
                self.assertEqual(legacy["payload"]["mentionContactRefs"], ["李四"])
                self.assertNotIn("members", legacy["payload"])
            finally:
                server.close()
                store.close()

    def test_reply_with_contract_field_is_accepted_and_round_trips(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            server = ChannelHostHttpServer(store, token="host-secret")
            server.start()
            try:
                created = self._post(
                    server.base_url,
                    {
                        "operationId": "op-reply-contract",
                        "conversationRef": "wxid-contact",
                        "payload": {
                            "kind": "reply",
                            "text": "收到",
                            "replyToChannelMessageId": "84",
                        },
                    },
                )
                self.assertEqual(created["payload"]["replyToChannelMessageId"], "84")
                self.assertNotIn("target_message_id", created["payload"])
                legacy = self._post(
                    server.base_url,
                    {
                        "operationId": "op-reply-legacy",
                        "conversationRef": "wxid-contact",
                        "payload": {
                            "kind": "reply",
                            "text": "收到",
                            "target_message_id": "85",
                        },
                    },
                )
                self.assertEqual(
                    legacy["payload"]["replyToChannelMessageId"], "85"
                )
                self.assertNotIn("target_message_id", legacy["payload"])
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


class RecordingDispatchSender:
    """Captures send_at/send_reply kwargs for dispatch contract tests."""

    def __init__(self):
        self.at_calls = []
        self.reply_calls = []

    def current_high_water(self, _conversation_ref):
        return 41

    def find_self_text_after(self, _conversation_ref, _text, _baseline_sort_seq):
        return None

    def send_at(self, conversation_ref, members, text):
        self.at_calls.append((conversation_ref, list(members), text))
        return SendAttempt("confirmed")

    def send_reply(self, conversation_ref, text, target_message_id=None):
        self.reply_calls.append((conversation_ref, text, target_message_id))
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


class DispatchContractTests(unittest.TestCase):
    """dispatch 层消费 ADR-0006 契约字段的回归测试。"""

    def test_dispatch_mention_reads_contract_field(self):
        sender = RecordingDispatchSender()
        attempt = _dispatch_send(
            sender,
            "45740750295@chatroom",
            {
                "kind": "mention",
                "text": "@可可猫",
                "mentionContactRefs": ["contact:channel:wxid_x:可可猫"],
            },
        )
        self.assertEqual(attempt.state, "confirmed")
        self.assertEqual(sender.at_calls, [("45740750295@chatroom", ["contact:channel:wxid_x:可可猫"], "@可可猫")])

    def test_dispatch_mention_without_refs_fails_cleanly(self):
        sender = RecordingDispatchSender()
        attempt = _dispatch_send(
            sender,
            "45740750295@chatroom",
            {"kind": "mention", "text": "@可可猫"},
        )
        self.assertEqual(attempt.state, "failed")
        self.assertEqual(attempt.error, "mention_members_required")
        self.assertEqual(sender.at_calls, [])

    def test_dispatch_reply_reads_contract_field(self):
        sender = RecordingDispatchSender()
        attempt = _dispatch_send(
            sender,
            "wxid-contact",
            {
                "kind": "reply",
                "text": "收到",
                "replyToChannelMessageId": "84",
            },
        )
        self.assertEqual(attempt.state, "confirmed")
        self.assertEqual(sender.reply_calls, [("wxid-contact", "收到", "84")])


class MemberNameResolutionTests(unittest.TestCase):
    """send_at 成员引用 → GUI 可见名字 的解析测试。"""

    def test_contact_channel_ref_is_unwrapped_and_resolved_to_nickname(self):
        class MemberDb:
            def get_nickname(self, user):
                return "可可猫" if user == "wxid_keke" else user

        sender = WeChatChannelSender(db=MemberDb())
        self.assertEqual(
            sender._resolve_member_name("contact:channel:wxid_keke"), "可可猫"
        )

    def test_account_qualified_contact_ref_uses_last_segment(self):
        class MemberDb:
            def get_nickname(self, user):
                return f"昵称:{user}"

        sender = WeChatChannelSender(db=MemberDb())
        self.assertEqual(
            sender._resolve_member_name("contact:channel:account-a:wxid_keke"),
            "昵称:wxid_keke",
        )

    def test_display_name_token_passes_through(self):
        sender = WeChatChannelSender(db=FakeContactDb())
        self.assertEqual(sender._resolve_member_name("可可猫"), "可可猫")

    def test_unresolvable_ref_falls_back_to_raw_ref(self):
        sender = WeChatChannelSender(db=UnresolvedContactDb())
        self.assertEqual(
            sender._resolve_member_name("contact:channel:wxid_ghost"),
            "wxid_ghost",
        )


class FakeAtGui:
    """模拟 GUI.at_member 弹层选人路径（send_at 的 UI 段）。"""

    def __init__(self, result=None):
        self.result = result or {"status": "成功"}
        self.calls = []

    def at_member(self, member, text, who=None, verify=False):
        self.calls.append((member, text, who, verify))
        return self.result


class _RosterDb:
    """带群成员名册的 DB 桩：wxid_in 在群里，wxid_out 不在。"""

    def __init__(self, roster=None, raise_on_roster=False):
        self._roster = roster if roster is not None else ["wxid_in"]
        self._raise = raise_on_roster
        self.roster_calls = []

    def get_nickname(self, user):
        return f"昵称:{user}"

    def get_group_members(self, chatroom_wxid):
        self.roster_calls.append(chatroom_wxid)
        if self._raise:
            raise RuntimeError("roster unavailable")
        return [{"username": u, "nick_name": f"昵称:{u}", "remark": None,
                 "is_owner": False} for u in self._roster]


class GroupMembershipPreflightTests(unittest.TestCase):
    """send_at 成员资格预检：roster 命中即秒判 not_found，省掉 UI 弹层。"""

    ROOM = "45740750295@chatroom"

    def test_out_of_group_ref_fails_without_touching_ui(self):
        gui = FakeAtGui()
        sender = WeChatChannelSender(
            db=_RosterDb(), gui_factory=lambda: gui
        )
        attempt = sender.send_at(
            self.ROOM, ["contact:channel:wxid_out"], "@不在群里"
        )
        self.assertEqual(attempt.state, "failed")
        self.assertEqual(attempt.error, "mention_member_not_found")
        self.assertEqual(gui.calls, [])

    def test_in_group_ref_proceeds_to_ui(self):
        gui = FakeAtGui()
        sender = WeChatChannelSender(
            db=_RosterDb(), gui_factory=lambda: gui
        )
        attempt = sender.send_at(
            self.ROOM, ["contact:channel:wxid_in"], "@在群里 你好"
        )
        self.assertEqual(attempt.state, "confirmed")
        self.assertEqual(len(gui.calls), 1)

    def test_display_name_token_skips_preflight(self):
        # 显示名 token 无法按 wxid 对照名册 → 跳过预检走原 UI 路径
        gui = FakeAtGui()
        sender = WeChatChannelSender(
            db=_RosterDb(), gui_factory=lambda: gui
        )
        attempt = sender.send_at(self.ROOM, ["可可猫"], "@可可猫")
        self.assertEqual(attempt.state, "confirmed")
        self.assertEqual(len(gui.calls), 1)

    def test_roster_failure_falls_back_to_ui(self):
        gui = FakeAtGui()
        sender = WeChatChannelSender(
            db=_RosterDb(raise_on_roster=True), gui_factory=lambda: gui
        )
        attempt = sender.send_at(
            self.ROOM, ["contact:channel:wxid_out"], "@不在群里"
        )
        self.assertEqual(attempt.state, "confirmed")
        self.assertEqual(len(gui.calls), 1)

    def test_private_chat_never_consults_roster(self):
        db = _RosterDb()
        sender = WeChatChannelSender(db=db, gui_factory=lambda: FakeAtGui())
        attempt = sender.send_at(
            "wxid-friend", ["contact:channel:wxid_anyone"], "@某人"
        )
        self.assertEqual(attempt.state, "confirmed")
        self.assertEqual(db.roster_calls, [])


if __name__ == "__main__":
    unittest.main()

import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from channel_host import outbound
from channel_host.event_store import EventStore
from channel_host.outbound import process_send_operations


class _BlockingSender:
    """UI 自动化卡死的最小替身：发送调用一直不返回。"""

    def __init__(self, release: threading.Event):
        self._release = release
        self.send_calls = 0

    def current_high_water(self, _conversation_ref):
        return 0

    def send_image(self, _conversation_ref, _path):
        self.send_calls += 1
        self._release.wait(timeout=30)
        return outbound.SendAttempt("confirmed", None)


class _HealthySender:
    def __init__(self):
        self.send_calls = 0

    def current_high_water(self, _conversation_ref):
        return 0

    def send_image(self, _conversation_ref, _path):
        self.send_calls += 1
        return outbound.SendAttempt("confirmed", None)


def _image_operation(store, operation_id):
    store.create_send_operation(
        operation_id,
        "wxid-contact",
        {"kind": "image", "path": "C:/staging/a.jpg"},
    )


class SendExecutionBoundTests(unittest.TestCase):
    """发送编排墙钟上限（2026-09-20 宿主卡死 38 分钟回归）。

    卡死的是 UI 自动化线程本身，Python 无法取消；这里验证的是编排侧的两条
    保证：单条操作有墙钟上限、上限之后轮询继续（不再整机静止）。
    """

    def setUp(self):
        outbound._SEND_PENDING = None

    def tearDown(self):
        outbound._SEND_PENDING = None

    def test_hung_send_is_marked_unknown_and_batch_completes(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            _image_operation(store, "op-hang")
            release = threading.Event()
            sender = _BlockingSender(release)
            try:
                with patch.object(outbound, "SEND_EXECUTION_TIMEOUT_SECONDS", 0.2):
                    started = time.monotonic()
                    processed = process_send_operations(store, sender)
                    elapsed = time.monotonic() - started

                self.assertEqual(processed, 1)
                self.assertLess(elapsed, 5)
                operation = store.get_send_operation("op-hang")
                self.assertEqual(operation["state"], "unknown")
                self.assertEqual(operation["error"], "send_execution_timeout")
                self.assertEqual(sender.send_calls, 1)
            finally:
                release.set()
                store.close()

    def test_polling_keeps_moving_while_ui_automation_is_still_stuck(self):
        """A2 回归：执行器卡住时排队操作保持 pending，不再未尝试即判 unknown。

        旧行为把没进过 UI 的操作 finish 成 unknown（「已发出但无法确认」），
        Core 不重发 → 消息静默丢失。新行为：认领前拦截、保持 pending 重试。
        本测试保留原有的两条保证：轮询不被卡死拖住、卡死期间不重复点按 UI。
        """
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            _image_operation(store, "op-stuck")
            _image_operation(store, "op-next")
            release = threading.Event()
            sender = _BlockingSender(release)
            try:
                with patch.object(outbound, "SEND_EXECUTION_TIMEOUT_SECONDS", 0.2):
                    started = time.monotonic()
                    # 只有 op-stuck 被处理（超时判 unknown）；op-next 被拦截保持 pending
                    self.assertEqual(process_send_operations(store, sender), 1)
                    self.assertLess(time.monotonic() - started, 1)

                    self.assertEqual(
                        store.get_send_operation("op-stuck")["error"],
                        "send_execution_timeout",
                    )
                    deferred = store.get_send_operation("op-next")
                    self.assertEqual(deferred["state"], "pending")
                    self.assertIsNone(deferred["error"])
                    # 卡死期间只发生过一次真实 UI 动作，不重复点按
                    self.assertEqual(sender.send_calls, 1)

                    # 之后的轮询继续推进（不再整机静止），依旧不进 UI，
                    # 且排队操作保持 pending 等执行器空闲后重试
                    _image_operation(store, "op-later")
                    started = time.monotonic()
                    self.assertEqual(process_send_operations(store, sender), 0)
                    self.assertLess(time.monotonic() - started, 1)
                    for operation_id in ("op-next", "op-later"):
                        operation = store.get_send_operation(operation_id)
                        self.assertEqual(operation["state"], "pending")
                        self.assertIsNone(operation["error"])
                    self.assertEqual(sender.send_calls, 1)
            finally:
                release.set()
                store.close()

    def test_health_send_path_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            _image_operation(store, "op-ok")
            sender = _HealthySender()
            try:
                self.assertEqual(process_send_operations(store, sender), 1)
                operation = store.get_send_operation("op-ok")
                self.assertEqual(operation["state"], "confirmed")
                self.assertEqual(sender.send_calls, 1)
            finally:
                store.close()

    def test_sender_exception_keeps_the_original_propagation_contract(self):
        """只加墙钟上限，不改异常语义：发送器抛错仍照旧冒泡给调用方。

        （既有 test_send_operations.test_crash_after_ui_action_reconciles_*
        依赖这一点：操作留在 executing，重启后凭库证据对账、绝不重发。）
        """

        class _ExplodingSender(_HealthySender):
            def send_image(self, _conversation_ref, _path):
                raise RuntimeError("gui exploded")

        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            _image_operation(store, "op-boom")
            try:
                with self.assertRaises(RuntimeError):
                    process_send_operations(store, _ExplodingSender())
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()

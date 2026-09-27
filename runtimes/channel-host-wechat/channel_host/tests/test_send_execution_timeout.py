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
        with tempfile.TemporaryDirectory() as directory:
            store = EventStore(str(Path(directory) / "events.sqlite3"))
            _image_operation(store, "op-stuck")
            _image_operation(store, "op-next")
            release = threading.Event()
            sender = _BlockingSender(release)
            try:
                with patch.object(outbound, "SEND_EXECUTION_TIMEOUT_SECONDS", 0.2):
                    started = time.monotonic()
                    self.assertEqual(process_send_operations(store, sender), 2)
                    # 一轮只等一次超时：第二条操作发现线程仍卡着，立刻判 unknown
                    self.assertLess(time.monotonic() - started, 1)

                    self.assertEqual(
                        store.get_send_operation("op-stuck")["error"],
                        "send_execution_timeout",
                    )
                    self.assertEqual(
                        store.get_send_operation("op-next")["error"],
                        "send_execution_in_progress",
                    )
                    # 卡死期间只发生过一次真实 UI 动作，不重复点按
                    self.assertEqual(sender.send_calls, 1)

                    # 之后的轮询继续推进（不再整机静止），且依旧不进 UI
                    _image_operation(store, "op-later")
                    started = time.monotonic()
                    self.assertEqual(process_send_operations(store, sender), 1)
                    self.assertLess(time.monotonic() - started, 1)
                    self.assertEqual(
                        store.get_send_operation("op-later")["error"],
                        "send_execution_in_progress",
                    )
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

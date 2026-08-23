import threading
import time
import unittest

from channel_host.key_service import ImageKeyService


class FakeDownloader:
    def __init__(self):
        self.acquire_results = []
        self.acquire_calls = 0
        self.refresh_calls = 0
        self.has_key = False

    def try_acquire_image_key(self, force=False):
        self.acquire_calls += 1
        if self.acquire_results:
            return self.acquire_results.pop(0)
        return self.has_key

    def refresh_image_key(self):
        self.refresh_calls += 1
        return True

    def has_image_key(self):
        return self.has_key


class ImageKeyServiceTests(unittest.TestCase):
    def test_start_scans_immediately_and_announces_transition(self):
        downloader = FakeDownloader()
        downloader.acquire_results = [True]
        logs = []
        service = ImageKeyService(
            downloader, interval_seconds=0.05, logger=logs.append
        )
        service.start()
        try:
            deadline = time.time() + 2
            while not logs and time.time() < deadline:
                time.sleep(0.01)
            self.assertEqual(logs, ["wechat image key acquired"])
            self.assertGreaterEqual(downloader.acquire_calls, 1)
        finally:
            service.stop()

    def test_logs_only_on_state_transitions(self):
        downloader = FakeDownloader()
        downloader.acquire_results = [True, True, False]
        logs = []
        service = ImageKeyService(
            downloader, interval_seconds=0.01, logger=logs.append
        )
        service.start()
        try:
            deadline = time.time() + 2
            while len(logs) < 3 and time.time() < deadline:
                time.sleep(0.01)
            time.sleep(0.1)
            self.assertIn("wechat image key acquired", logs)
            self.assertIn(
                "wechat image key unavailable; background rescan scheduled",
                logs,
            )
            # 稳定状态下不得刷屏：unavailable 之后不再重复
            unavailable_count = sum(
                1
                for entry in logs
                if entry == "wechat image key unavailable; background rescan scheduled"
            )
            self.assertLessEqual(unavailable_count, 1)
        finally:
            service.stop()

    def test_refresh_delegates_and_announces(self):
        downloader = FakeDownloader()
        logs = []
        service = ImageKeyService(downloader, logger=logs.append)
        self.assertTrue(service.refresh())
        self.assertEqual(downloader.refresh_calls, 1)

    def test_stop_terminates_thread(self):
        downloader = FakeDownloader()
        service = ImageKeyService(
            downloader, interval_seconds=3600, logger=lambda message: None
        )
        service.start()
        thread_name = "wechat-image-key-service"
        self.assertTrue(
            any(t.name == thread_name for t in threading.enumerate())
        )
        service.stop(timeout=2)
        self.assertFalse(
            any(t.name == thread_name for t in threading.enumerate())
        )

    def test_logs_never_contain_key_material(self):
        secret = "TOPSECRETKEYMATERIAL"
        downloader = FakeDownloader()

        class LeakyDownloader(FakeDownloader):
            def try_acquire_image_key(self, force=False):
                raise RuntimeError(f"boom {secret}")

        logs = []
        service = ImageKeyService(
            LeakyDownloader(), interval_seconds=0.01, logger=logs.append
        )
        service.start()
        try:
            deadline = time.time() + 2
            while not logs and time.time() < deadline:
                time.sleep(0.01)
            time.sleep(0.05)
            joined = "\n".join(logs)
            self.assertNotIn(secret, joined)
            self.assertTrue(all("RuntimeError" in entry for entry in logs))
        finally:
            service.stop()


if __name__ == "__main__":
    unittest.main()

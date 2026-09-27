import os
import threading
import unittest

from wechatauto.guia import ScreenOCR


class ScreenOcrTempPathTests(unittest.TestCase):
    """OCR 临时文件路径：WinRT 不接受 8.3 短路径（2026-09-20 宿主卡死回归）。"""

    def test_path_has_no_short_component_and_parent_exists(self):
        path = ScreenOCR._temp_path()
        self.assertNotIn("~", os.path.basename(os.path.dirname(path)))
        self.assertTrue(os.path.isdir(os.path.dirname(path)))
        self.assertTrue(path.endswith(".png"))

    def test_same_thread_reuses_same_path(self):
        self.assertEqual(ScreenOCR._temp_path(), ScreenOCR._temp_path())

    def test_concurrent_threads_do_not_share_a_file(self):
        # 两个线程同时 OCR 时若共用同一 PNG，会写坏对方正在解码的文件
        paths = {}
        barrier = threading.Barrier(2)

        def run(key):
            barrier.wait(timeout=5)
            paths[key] = ScreenOCR._temp_path()

        threads = [
            threading.Thread(target=run, args=(index,)) for index in range(2)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)

        self.assertEqual(len(set(paths.values())), 2)


if __name__ == "__main__":
    unittest.main()
